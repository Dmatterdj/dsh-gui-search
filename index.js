/**
 * dsh-gui-search — host half.
 *
 * Adds literal, case-insensitive full-text (substring) search over Session
 * message bodies to the DSH sidebar search box, which by default only matches
 * Session titles.
 *
 * Why substring and not FTS5
 * --------------------------
 * DSH ships an optional SQLite FTS5 content index
 * (`@deepseek-ai/dsh-session-query-sqlite`) whose virtual tables are created
 * with `tokenize = 'unicode61'`. That tokenizer does not segment CJK: a run of
 * consecutive Chinese characters becomes ONE token, and the caller's query is
 * wrapped as a single quoted FTS5 phrase. The practical result is that
 * searching `搜索` never matches a message containing `全文搜索`. A literal
 * substring scan has no such limitation and also handles 1-character queries.
 *
 * What is replaced
 * ----------------
 * Only `sessionQuery.searchSessions`. Documents are read through the inherited
 * `sessionQuery.filterEvents()` and sessions through the inherited
 * `listSessions()`, so authorization, live-vs-persisted preference and text
 * extraction all stay in core code. Titles, exact reads, traces and filters are
 * untouched.
 *
 * Locating a hit
 * --------------
 * The stock sidebar result row only carries a Session id, so the client half
 * cannot know *which* message matched. An extra read-only route
 * `GET /api/gui-search/locate` returns the matching `{seq}` for one Session, so
 * the client can scroll to and flash the exact row.
 *
 * Zero runtime dependencies.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-gui-search'

/** Services this plugin needs: the query service it wraps and the live store. */
export const inject = ['sessionQuery', 'sessions']

/** Only conversation messages take part in content search. */
const INDEXED_TYPES = new Set(['user/message', 'assistant/message'])

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SNIPPET_CHARS = 240
const SNIPPET_LEAD = 60
const WARMUP_DELAY_MS = 2500
const ROUTE_PREFIX = '/api/gui-search'

/**
 * Split a raw query into lowercase needles. Whitespace separates terms and the
 * terms are ANDed, mirroring the usual search-box expectation.
 *
 * @param {string} query
 * @returns {string[]}
 */
function normalizeNeedles(query) {
  const trimmed = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (trimmed === '') return []
  return trimmed.split(/\s+/u).filter((term) => term !== '')
}

/**
 * Count non-overlapping occurrences of one needle.
 *
 * @param {string} haystack already lowercased
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * Find the earliest position where every needle occurs, or -1.
 *
 * @param {string} lowered already lowercased text
 * @param {string[]} needles
 * @returns {number}
 */
function firstMatchIndex(lowered, needles) {
  let index = -1
  for (const needle of needles) {
    const at = lowered.indexOf(needle)
    if (at < 0) return -1
    if (index < 0 || at < index) index = at
  }
  return index
}

/**
 * Build a single-line excerpt centered on the first match.
 *
 * @param {string} text
 * @param {string[]} needles
 * @param {number} maxChars
 * @returns {string}
 */
function makeSnippet(text, needles, maxChars) {
  const normalized = text.replace(/\s+/gu, ' ')
  const lowered = normalized.toLowerCase()
  const at = firstMatchIndex(lowered, needles)
  const anchor = at >= 0 ? at : 0
  const start = Math.max(0, anchor - SNIPPET_LEAD)
  const end = Math.min(normalized.length, start + maxChars)
  const body = normalized.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${body}${end < normalized.length ? '…' : ''}`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {void}
 */
export function apply(ctx, config) {
  const debugEnabled = config?.debug === true
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const logPath = join(home, 'gui-search.log')

  /** @param {string} message */
  const debugLog = (message) => {
    if (!debugEnabled) return
    try {
      mkdirSync(home, { recursive: true })
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Logging is best-effort and must never break a search.
    }
  }

  const sessionQuery = ctx.sessionQuery
  const sessions = ctx.sessions
  if (sessionQuery === undefined || sessions === undefined) {
    debugLog('missing sessionQuery/sessions service; plugin inactive')
    return
  }

  const originalSearchSessions = sessionQuery.searchSessions
  const originalListSessions =
    typeof sessionQuery.listSessions === 'function'
      ? sessionQuery.listSessions.bind(sessionQuery)
      : undefined
  const originalFilterEvents = sessionQuery.filterEvents.bind(sessionQuery)

  if (typeof originalSearchSessions !== 'function' || originalListSessions === undefined) {
    debugLog('sessionQuery lacks searchSessions/listSessions; plugin inactive')
    return
  }
  const searchSessionsOriginal = originalSearchSessions.bind(sessionQuery)

  /** @type {Map<string, {version: string, docs: {seq: number, time: number, type: string, text: string, lowered: string}[]}>} */
  const cache = new Map()
  /** @type {Map<string, Promise<{version: string, docs: any[]}>>} */
  const inflight = new Map()
  let disposed = false
  let warmupRunning = false

  /**
   * Version stamp used to invalidate one Session's cached documents.
   *
   * @param {{header: {revision?: string, generation?: number}}} record
   * @returns {string}
   */
  const versionOf = (record) => {
    const header = record?.header ?? {}
    return `${String(header.revision ?? '')}:${String(header.generation ?? '')}`
  }

  /**
   * Load (or reuse) the indexed messages of one Session.
   *
   * @param {{header: {id: string}}} record
   * @returns {Promise<{version: string, docs: any[]}>}
   */
  const loadDocs = (record) => {
    const id = record.header.id
    const version = versionOf(record)
    const cached = cache.get(id)
    if (cached !== undefined && cached.version === version) return Promise.resolve(cached)

    const pending = inflight.get(id)
    if (pending !== undefined) return pending

    const load = (async () => {
      /** @type {any[]} */
      let docs = []
      try {
        const events = await originalFilterEvents(id, [])
        docs = events
          .filter((event) => event.surface === 'current' && INDEXED_TYPES.has(event.type) === true)
          .map((event) => {
            const text = typeof event.text === 'string' ? event.text : ''
            return {
              seq: event.seq,
              time: event.time,
              type: event.type,
              text,
              lowered: text.toLowerCase(),
            }
          })
          .filter((doc) => doc.text !== '')
      } catch {
        // A corrupt or concurrently removed Session contributes nothing rather
        // than failing the whole search.
        docs = []
      }
      const entry = { version, docs }
      cache.set(id, entry)
      return entry
    })().finally(() => inflight.delete(id))

    inflight.set(id, load)
    return load
  }

  /**
   * Pick the message with the most occurrences of every needle.
   *
   * @param {any[]} docs
   * @param {string[]} needles
   * @returns {{doc: any, count: number} | undefined}
   */
  const pickBest = (docs, needles) => {
    let best
    for (const doc of docs) {
      let total = 0
      let all = true
      for (const needle of needles) {
        const count = countOccurrences(doc.lowered, needle)
        if (count === 0) {
          all = false
          break
        }
        total += count
      }
      if (!all) continue
      if (
        best === undefined ||
        total > best.count ||
        (total === best.count && doc.time > best.doc.time)
      ) {
        best = { doc, count: total }
      }
    }
    return best
  }

  const warmup = async () => {
    if (warmupRunning || disposed) return
    warmupRunning = true
    try {
      const records = await originalListSessions()
      for (const record of records) {
        if (disposed) return
        if (record.header.cwd === undefined) continue
        const known = cache.get(record.header.id)
        if (known !== undefined && known.version === versionOf(record)) continue
        await loadDocs(record)
        await new Promise((resolve) => setImmediate(resolve))
      }
    } catch {
      // Best-effort; on-demand loading covers anything missed.
    } finally {
      warmupRunning = false
      debugLog(`warmup done: ${String(cache.size)} sessions cached`)
    }
  }

  const warmupTimer = setTimeout(() => {
    void warmup()
  }, WARMUP_DELAY_MS)
  if (typeof warmupTimer.unref === 'function') warmupTimer.unref()

  /**
   * Replacement for `sessionQuery.searchSessions`. Falls back to the original
   * implementation for requests this plugin does not serve.
   *
   * @param {any} request
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<any>}
   */
  const searchSessions = async (request, options) => {
    const signal = options?.signal
    const query = typeof request?.query === 'string' ? request.query : ''
    const needles = normalizeNeedles(query)

    // Title-only callers and empty queries keep the stock behavior.
    if (needles.length === 0) return searchSessionsOriginal(request, options)

    // A caller that explicitly excludes the current surface is outside this
    // plugin's scope; delegate so its semantics are preserved exactly.
    const eventFilters = Array.isArray(request?.eventFilters) ? request.eventFilters : []
    const surfaceFilter = eventFilters.find((filter) => filter?.kind === 'surface')
    if (
      surfaceFilter !== undefined &&
      Array.isArray(surfaceFilter.values) &&
      surfaceFilter.values.includes('current') === false
    ) {
      return searchSessionsOriginal(request, options)
    }
    const typeFilter = eventFilters.find((filter) => filter?.kind === 'type')
    if (
      typeFilter !== undefined &&
      Array.isArray(typeFilter.values) &&
      typeFilter.values.some((value) => INDEXED_TYPES.has(value)) === false
    ) {
      return searchSessionsOriginal(request, options)
    }

    // Session-level filters are nuanced; defer to the original rather than
    // silently ignoring them.
    const sessionFilters = request?.sessionFilters
    if (Array.isArray(sessionFilters) && sessionFilters.length > 0) {
      return searchSessionsOriginal(request, options)
    }

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(request?.limit) ? Number(request.limit) : DEFAULT_LIMIT),
    )
    const snippetChars = Number.isFinite(request?.snippetChars)
      ? Number(request.snippetChars)
      : SNIPPET_CHARS

    signal?.throwIfAborted?.()

    /** @type {any[]} */
    const records = await originalListSessions(signal)
    signal?.throwIfAborted?.()

    const ranked = []
    for (const record of records) {
      if (disposed) break
      signal?.throwIfAborted?.()
      if (record.header.cwd === undefined) continue
      const entry = await loadDocs(record)
      if (entry.docs.length === 0) continue
      const best = pickBest(entry.docs, needles)
      if (best === undefined) continue
      ranked.push({ header: record.header, doc: best.doc, count: best.count })
    }

    ranked.sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (right.doc.time !== left.doc.time) return right.doc.time - left.doc.time
      return (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0)
    })

    debugLog(`search ${JSON.stringify(query)} -> ${String(ranked.length)} sessions`)

    return {
      items: ranked.slice(0, limit).map((hit) => ({
        header: hit.header,
        bestMatch: {
          sessionId: hit.header.id,
          seq: hit.doc.seq,
          type: hit.doc.type,
          surface: 'current',
          snippet: makeSnippet(hit.doc.text, needles, snippetChars),
        },
      })),
    }
  }

  sessionQuery.searchSessions = searchSessions
  sessionQuery.__dshGuiSearchInstalled = true
  debugLog('activated')

  /**
   * Resolve the best matching message position inside one Session.
   *
   * @param {string} sessionId
   * @param {string} query
   * @returns {Promise<{seq: number, time: number, type: string, snippet: string, count: number} | undefined>}
   */
  const locateInSession = async (sessionId, query) => {
    const needles = normalizeNeedles(query)
    if (sessionId === '' || needles.length === 0) return undefined

    let docs
    const cached = cache.get(sessionId)
    if (cached !== undefined) {
      docs = cached.docs
    } else {
      const records = await originalListSessions()
      const record = records.find((candidate) => candidate.header.id === sessionId)
      if (record === undefined) return undefined
      docs = (await loadDocs(record)).docs
    }

    const best = pickBest(docs, needles)
    if (best === undefined) return undefined
    return {
      seq: best.doc.seq,
      time: best.doc.time,
      type: best.doc.type,
      snippet: makeSnippet(best.doc.text, needles, SNIPPET_CHARS),
      count: best.count,
    }
  }

  /**
   * Reject cross-site callers. The route is read-only, but it exposes
   * conversation text, so it is fenced like other local plugin routes.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  const isTrustedRequest = (req) => {
    const host = req.headers.host
    if (typeof host !== 'string') return false
    const hostname = host.replace(/:\d+$/u, '')
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false

    const fetchSite = req.headers['sec-fetch-site']
    if (typeof fetchSite === 'string' && fetchSite === 'cross-site') return false

    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      try {
        const parsed = new URL(origin)
        if (parsed.host !== host) return false
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} payload
   */
  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined) return

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            if (isTrustedRequest(req) === false) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            let url
            try {
              url = new URL(req.url ?? '/', 'http://127.0.0.1')
            } catch {
              sendJson(res, 400, { ok: false, error: 'bad request' })
              return
            }
            const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

            if (route === '/health') {
              sendJson(res, 200, {
                ok: true,
                name,
                sessions: cache.size,
                installed: sessionQuery.__dshGuiSearchInstalled === true,
              })
              return
            }

            if (route === '/locate') {
              const sessionId = url.searchParams.get('session') ?? ''
              const query = url.searchParams.get('q') ?? ''
              locateInSession(sessionId, query)
                .then((hit) => {
                  if (hit === undefined) {
                    sendJson(res, 404, { ok: false, error: 'no match' })
                    return
                  }
                  sendJson(res, 200, { ok: true, ...hit })
                })
                .catch((error) => {
                  sendJson(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  })
                })
              return
            }

            sendJson(res, 404, { ok: false, error: 'unknown route' })
          },
        }),
      'gui-search: routes',
    )
  })

  ctx.effect(
    () => () => {
      disposed = true
      clearTimeout(warmupTimer)
      cache.clear()
      inflight.clear()
      if (sessionQuery.__dshGuiSearchInstalled === true) {
        sessionQuery.searchSessions = searchSessionsOriginal
        delete sessionQuery.__dshGuiSearchInstalled
      }
      debugLog('disposed')
    },
    'gui-search: teardown',
  )
}

export default { name, inject, apply }
