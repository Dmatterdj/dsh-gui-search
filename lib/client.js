/**
 * dsh-gui-search — browser half.
 *
 * The host half makes the sidebar search box match message *content*, not just
 * titles. This half closes the second half of the problem: the stock result row
 * only carries a Session id, so selecting a result opens the Session but never
 * navigates to the message that matched.
 *
 * Flow
 * ----
 *   1. a capture-phase click on a search-result row remembers the query and the
 *      Session that was open before the click;
 *   2. once the target Session renders, ask the host which `seq` matched
 *      (`GET /api/gui-search/locate`);
 *   3. page older history in until that `seq` enters the loaded window, resolve
 *      its DOM anchor through the chat snapshot's `anchorSeq`, scroll it into
 *      view, flash the row and highlight every occurrence.
 *
 * Using `anchorSeq` instead of matching text against the DOM means a phrase
 * that appears many times still resolves to the correct row.
 *
 * No React and no external modules: this is a plain client-module bundle in the
 * format the host serves from `/plugins`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gui-search',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const PLUGIN_ID = 'dsh-gui-search'
    const HIGHLIGHT_NAME = 'dsh-gui-search-hit'
    const STYLE_ID = 'dsh-gui-search/style'
    const FLASH_CLASS = 'dsh-gui-search-flash'

    const RESULT_ROW_SELECTOR = '[class*="searchResultRow"]'
    const SEARCH_INPUT_SELECTOR = '[class*="searchInput"]'
    const SESSION_HOST_SELECTOR = '[data-conversation-session]'
    const ANCHOR_SELECTOR = '[data-chat-anchor-key]'

    const PLACEHOLDER_ZH = '搜索会话名称与内容'
    const PLACEHOLDER_EN = 'Search session names and content'

    const MAX_PAGES = 40
    const MAX_RANGES = 400
    const OPEN_TIMEOUT_MS = 12000
    const LOCATE_TIMEOUT_MS = 10000

    const CSS_TEXT = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(255, 196, 0, .55);
  color: inherit;
  border-radius: 2px;
}
.${FLASH_CLASS} {
  animation: dsh-gui-search-flash 1.6s ease-out 1;
}
@keyframes dsh-gui-search-flash {
  0%   { outline: 2px solid rgba(255, 176, 0, .95); outline-offset: 4px; border-radius: 8px; }
  100% { outline: 2px solid rgba(255, 176, 0, 0);   outline-offset: 4px; border-radius: 8px; }
}
`

    /* ---------------------------------------------------------------- utils */

    /** @returns {Promise<void>} */
    function frame() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 16)
      })
    }

    /**
     * Poll `read` until it returns a defined value or the deadline passes.
     *
     * @template T
     * @param {() => T | undefined} read
     * @param {number} timeoutMs
     * @param {() => boolean} isDisposed
     * @returns {Promise<T | undefined>}
     */
    function waitFor(read, timeoutMs, isDisposed) {
      return new Promise((resolve) => {
        const started = Date.now()
        const step = () => {
          if (isDisposed()) return resolve(undefined)
          let value
          try {
            value = read()
          } catch {
            value = undefined
          }
          if (value !== undefined) return resolve(value)
          if (Date.now() - started >= timeoutMs) return resolve(undefined)
          setTimeout(step, 80)
        }
        step()
      })
    }

    /**
     * @param {string} query
     * @returns {string[]}
     */
    function normalizeNeedles(query) {
      const trimmed = typeof query === 'string' ? query.trim().toLowerCase() : ''
      if (trimmed === '') return []
      return trimmed.split(/\s+/u).filter((term) => term !== '')
    }

    /**
     * Reveal a collapsed container so its content becomes scrollable.
     *
     * A hit can sit inside a folded reasoning block. An unrendered `<details>`
     * has zero height, so neither `scrollIntoView` nor a highlight can reach
     * it; opening the ancestor chain first makes the row real.
     *
     * @param {Element} target
     * @returns {boolean} whether anything was opened
     */
    function openCollapsedAncestors(target) {
      let opened = false
      for (let node = target; node !== null; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement && node.open === false) {
          node.open = true
          opened = true
        }
      }
      return opened
    }

    /** @returns {string} */
    function readSearchQuery() {
      for (const input of document.querySelectorAll(SEARCH_INPUT_SELECTOR)) {
        if (input instanceof HTMLInputElement) {
          const value = input.value.trim()
          if (value !== '') return value
        }
      }
      return ''
    }

    /** @returns {string | undefined} */
    function currentSessionId() {
      const host = document.querySelector(SESSION_HOST_SELECTOR)
      const value = host?.getAttribute('data-conversation-session')
      return value === null || value === undefined || value === '' ? undefined : value
    }

    /** @param {string} value */
    function escapeAttribute(value) {
      return String(value).replaceAll('"', '\\"')
    }

    /* --------------------------------------------------------------- styles */

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    function removeStyle() {
      document.getElementById(STYLE_ID)?.remove()
      try {
        if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
          CSS.highlights.delete(HIGHLIGHT_NAME)
        }
      } catch {
        // Ignore: the Highlight registry is optional.
      }
    }

    /* ---------------------------------------------------------- placeholders */

    /**
     * The shipped placeholder says "session names" because the stock box only
     * matched titles. Content search makes that copy wrong, so widen it.
     *
     * @returns {() => void} disconnect
     */
    function installPlaceholder() {
      /** @param {Element | null} input */
      const patch = (input) => {
        if (!(input instanceof HTMLInputElement)) return
        const current = input.getAttribute('placeholder') ?? ''
        if (current === PLACEHOLDER_ZH || current === PLACEHOLDER_EN) return
        const chinese =
          /[\u3400-\u9fff]/u.test(current) ||
          (document.documentElement.lang ?? '').toLowerCase().startsWith('zh')
        input.setAttribute('placeholder', chinese ? PLACEHOLDER_ZH : PLACEHOLDER_EN)
      }

      /** @param {Node} root */
      const scan = (root) => {
        if (root instanceof HTMLInputElement) patch(root)
        if (root instanceof Element) {
          for (const input of root.querySelectorAll(SEARCH_INPUT_SELECTOR)) patch(input)
        }
      }

      scan(document)
      if (typeof MutationObserver !== 'function') return () => {}
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) scan(node)
        }
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
      }
    }

    /* ---------------------------------------------------------------- jumps */

    /**
     * Resolve the DOM row plus the exact text range for a hit.
     *
     * Preferred: the chat snapshot maps `anchorSeq` to a node key, which stays
     * unambiguous even when the phrase repeats. When a host build does not
     * expose that snapshot, fall back to the first text node containing the
     * query, then climb to its nearest anchored row so the flash lands on one
     * message instead of a whole turn group.
     *
     * @param {string} sessionId
     * @param {number} seq
     * @param {string[]} needles
     * @returns {{row: HTMLElement, range: Range | null, exact: boolean} | undefined}
     */
    function findRow(sessionId, seq, needles) {
      const chat = window.__dshGuiSearchChat?.(sessionId)
      const key = chat === undefined ? null : findAnchorKey(chat, seq)
      if (key !== null) {
        const row = rowByAnchorKey(key)
        if (row !== null) return { row, range: null, exact: true }
      }
      // A match can hide inside a folded reasoning block. Expanding is what
      // makes the row real enough to scroll to and highlight.
      expandCollapsedBlocks()
      const found = findFirstTextMatch(needles)
      if (found === undefined) return undefined
      const row = found.node.parentElement?.closest(ANCHOR_SELECTOR)
      if (!(row instanceof HTMLElement)) return undefined
      return { row, range: found.range, exact: false }
    }

    /**
     * Open every folded reasoning block inside the transcript.
     *
     * Only `details` elements are touched, and only while a jump is in flight;
     * the user's own collapse choices elsewhere are not altered.
     *
     * @returns {number} blocks opened
     */
    function expandCollapsedBlocks() {
      let opened = 0
      for (const details of document.querySelectorAll('details')) {
        if (details instanceof HTMLDetailsElement && details.open === false) {
          details.open = true
          opened += 1
        }
      }
      return opened
    }

    /**
     * Find the first transcript text node containing every needle.
     *
     * @param {string[]} needles
     * @returns {{node: Text, range: Range} | undefined}
     */
    function findFirstTextMatch(needles) {
      for (const root of document.querySelectorAll(SESSION_HOST_SELECTOR)) {
        if (!(root instanceof HTMLElement)) continue
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const text = (node.nodeValue ?? '').toLowerCase()
          if (text === '') continue
          let anchor = -1
          let all = true
          for (const needle of needles) {
            const at = text.indexOf(needle)
            if (at < 0) {
              all = false
              break
            }
            if (anchor < 0 || at < anchor) anchor = at
          }
          if (!all || anchor < 0) continue
          // Skip text inside a collapsed or virtualized-away row: it has no
          // layout box, so scrolling to it cannot work.
          const holder = node.parentElement
          if (holder === null) continue
          if (holder.closest('[hidden]') !== null) continue
          const range = document.createRange()
          range.setStart(node, anchor)
          range.setEnd(node, anchor + needles[0].length)
          return { node, range }
        }
      }
      return undefined
    }

    /**
     * Node key whose `anchorSeq` equals the hit's event seq.
     *
     * @param {any} chat
     * @param {number} seq
     * @returns {string | null}
     */
    function findAnchorKey(chat, seq) {
      const order = chat?.order
      const nodes = chat?.nodes
      if (!Array.isArray(order) || nodes === undefined || nodes === null) return null
      for (const key of order) {
        if (typeof key !== 'string') continue
        if (nodes.get?.(key)?.anchorSeq === seq) return key
      }
      return null
    }

    /**
     * @param {string} key
     * @returns {HTMLElement | null}
     */
    function rowByAnchorKey(key) {
      const rows = document.querySelectorAll(ANCHOR_SELECTOR)
      for (const row of rows) {
        if (row instanceof HTMLElement && row.dataset.chatAnchorKey === key) return row
      }
      return null
    }

    /**
     * Page older history in until `seq` falls inside the loaded window.
     *
     * @param {any} session
     * @param {number} seq
     */
    async function loadUntilVisible(session, seq) {
      if (typeof session?.loadOlder !== 'function') return
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (session.hasMore !== true) return
        if (typeof session.baseSeq === 'number' && session.baseSeq <= seq) return
        await session.loadOlder()
        await frame()
      }
    }

    /**
     * Highlight every occurrence of the needles inside one row using the CSS
     * Custom Highlight API (no DOM mutation, so React stays consistent).
     *
     * @param {HTMLElement} row
     * @param {string[]} needles
     * @returns {number} number of highlighted ranges
     */
    function highlightRow(row, needles) {
      try {
        if (typeof CSS === 'undefined' || CSS.highlights === undefined) return 0
        if (typeof Highlight !== 'function') return 0
        /** @type {Range[]} */
        const ranges = []
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (ranges.length >= MAX_RANGES) break
          const text = node.nodeValue ?? ''
          if (text === '') continue
          const lowered = text.toLowerCase()
          for (const needle of needles) {
            let from = 0
            for (;;) {
              if (ranges.length >= MAX_RANGES) break
              const at = lowered.indexOf(needle, from)
              if (at < 0) break
              const range = document.createRange()
              range.setStart(node, at)
              range.setEnd(node, at + needle.length)
              ranges.push(range)
              from = at + needle.length
            }
          }
        }
        if (ranges.length === 0) return 0
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
        return ranges.length
      } catch {
        return 0
      }
    }

    /**
     * Scroll the row into view, flash it and highlight the matched terms.
     *
     * @param {HTMLElement} row
     * @param {string[]} needles
     */
    /**
     * Center one element in the transcript viewport.
     *
     * Native `scrollIntoView` is the only reliable path here: the transcript
     * virtualizes its rows, so the scroller reports `scrollHeight ===
     * clientHeight` and assigning `scrollTop` to it does nothing at all.
     *
     * @param {Element} target
     */
    function centerInView(target) {
      try {
        target.scrollIntoView({ block: 'center', behavior: 'auto' })
      } catch {
        try {
          target.scrollIntoView()
        } catch {
          // Nothing else to try.
        }
      }
    }

    /**
     * Keep the hit clear of the composer pinned to the bottom of the viewport.
     *
     * @param {Element} target
     * @returns {boolean} whether the target now sits in the safe band
     */
    function isInSafeBand(target) {
      const rect = target.getBoundingClientRect()
      const viewport = window.innerHeight || document.documentElement.clientHeight || 0
      if (viewport === 0) return false
      // The composer overlays roughly the bottom quarter of the viewport.
      const safeTop = 72
      const safeBottom = viewport * 0.74
      return rect.top >= safeTop && rect.top <= safeBottom
    }

    async function settleInView(target) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        openCollapsedAncestors(target)
        centerInView(target)
        await frame()
        if (isInSafeBand(target)) {
          // Confirm it stays put across one more frame before accepting.
          await frame()
          if (isInSafeBand(target)) {
            centerInView(target)
            return true
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      // Last resort: accept any on-screen position rather than not moving.
      centerInView(target)
      return isInSafeBand(target)
    }

    async function revealRow(row, needles, range) {
      // Scrolling by the matched range is far more precise than centering the
      // whole row: a message row can be many screens tall.
      const target = range !== null ? range.startContainer.parentElement : row
      row.classList.add(FLASH_CLASS)
      setTimeout(() => row.classList.remove(FLASH_CLASS), 2400)
      highlightRow(row, needles)
      await settleInView(target ?? row)
    }

    /**
     * Full jump: open the Session, locate the seq on the host, page history in,
     * then reveal the anchored row.
     *
     * @param {any} ctx
     * @param {string} sessionId
     * @param {string} query
     * @param {() => boolean} isDisposed
     * @returns {Promise<boolean>}
     */
    async function jumpToMatch(ctx, sessionId, query, isDisposed) {
      const needles = normalizeNeedles(query)
      if (needles.length === 0) return false

      let hit
      try {
        const params = new URLSearchParams({ session: sessionId, q: query })
        const response = await fetch(`/api/gui-search/locate?${params.toString()}`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return false
        const payload = await response.json()
        if (payload?.ok !== true || typeof payload.seq !== 'number') return false
        hit = payload
      } catch {
        return false
      }

      const sessions = ctx.sessions
      if (sessions === undefined) return false

      try {
        sessions.open(sessionId)
      } catch {
        // Opening is best-effort; render may already be in flight.
      }

      const session = sessions.binding?.(sessionId)?.session
      if (session?.open !== undefined) {
        try {
          await session.open()
        } catch {
          // Ignore: fall through to polling.
        }
      }

      try {
        await loadUntilVisible(session, hit.seq)
      } catch {
        // Ignore: a partial window may still contain the row.
      }

      // Page older history in until the row renders, or history runs out.
      let located = findRow(sessionId, hit.seq, needles)
      for (let page = 0; located === undefined && page < MAX_PAGES; page += 1) {
        if (session?.hasMore !== true || typeof session?.loadOlder !== 'function') break
        try {
          await session.loadOlder()
        } catch {
          break
        }
        await frame()
        located = findRow(sessionId, hit.seq, needles)
      }
      if (located === undefined) {
        located = await waitFor(
          () => findRow(sessionId, hit.seq, needles),
          LOCATE_TIMEOUT_MS,
          isDisposed,
        )
      }
      if (located === undefined) return false

      await revealRow(located.row, needles, located.range)
      return true
    }

    /* ----------------------------------------------------------- lifecycle */

    exports.inject = ['sessions']

    /**
     * @param {any} ctx
     */
    exports.apply = function apply(ctx) {
      if (typeof document === 'undefined') return

      let disposed = false
      const isDisposed = () => disposed

      ensureStyle()
      const disconnectPlaceholder = installPlaceholder()

      // Expose the chat snapshot lookup so `findRow` (module scope) can reach a
      // Session's node map without threading `ctx` through every helper.
      window.__dshGuiSearchChat = (sessionId) => {
        try {
          return ctx.sessions?.binding?.(sessionId)?.session?.snapshotCache?.chat
        } catch {
          return undefined
        }
      }

      // Read-only diagnostics: helps users (and issue reports) explain why a
      // jump did or did not land. It exposes no conversation text.
      window.__dshGuiSearchDebug = (sessionId, seq) => {
        try {
          const id = sessionId ?? currentSessionId()
          const binding = ctx.sessions?.binding?.(id)
          const session = binding?.session
          const chat = session?.snapshotCache?.chat
          const order = Array.isArray(chat?.order) ? chat.order : []
          const seqs = []
          if (chat?.nodes?.get !== undefined) {
            for (const key of order) {
              const node = chat.nodes.get(key)
              if (typeof node?.anchorSeq === 'number') seqs.push(node.anchorSeq)
            }
          }
          const target = typeof seq === 'number' ? seq : undefined
          const found = target === undefined ? undefined : findAnchorKey(chat, target)
          return {
            sessionId: id,
            hasBinding: binding !== undefined,
            hasSession: session !== undefined,
            hasSnapshot: chat !== undefined,
            orderLength: order.length,
            anchorSeqCount: seqs.length,
            anchorSeqMin: seqs.length > 0 ? Math.min(...seqs) : undefined,
            anchorSeqMax: seqs.length > 0 ? Math.max(...seqs) : undefined,
            baseSeq: session?.baseSeq,
            hasMore: session?.hasMore,
            targetSeq: target,
            matchedKey: found,
            sessionKeys: session === undefined ? [] : Object.keys(session),
            bindingKeys: binding === undefined ? [] : Object.keys(binding),
            snapshotKeys:
              session?.snapshotCache === undefined || session?.snapshotCache === null
                ? []
                : Object.keys(session.snapshotCache),
            chatKeys:
              session?.snapshotCache?.chat === undefined ||
              session?.snapshotCache?.chat === null
                ? []
                : Object.keys(session.snapshotCache.chat),
            projectionKeys:
              session?.projections === undefined || session?.projections === null
                ? []
                : Object.keys(session.projections),
            rowsInfo: (() => {
              try {
                const rows = session?.projections?.rows
                if (rows === undefined || rows === null) return undefined
                if (Array.isArray(rows)) {
                  return { kind: 'array', length: rows.length, first: rows[0] && Object.keys(rows[0]) }
                }
                if (typeof rows === 'object') {
                  return {
                    kind: 'object',
                    keys: Object.keys(rows).slice(0, 12),
                    ctor: rows.constructor?.name,
                  }
                }
                return { kind: typeof rows }
              } catch (error) {
                return { error: String(error) }
              }
            })(),
          }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }

      /** @type {{query: string, beforeSession: string | undefined, startedAt: number} | null} */
      let pending = null

      /**
       * @param {MouseEvent} event
       */
      const onClick = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest(RESULT_ROW_SELECTOR)
        if (row === null) return
        // The archived-row unarchive button is not a navigation.
        if (target.closest('button') !== null) return
        if (row.hasAttribute('aria-description')) return
        const query = readSearchQuery()
        if (query === '') return
        pending = {
          query,
          beforeSession: currentSessionId(),
          startedAt: Date.now(),
        }
        // Do not preventDefault: let the stock handler open the Session.
        void watchPending()
      }

      /** Follow the Session switch, then jump. */
      const watchPending = async () => {
        const snapshot = pending
        if (snapshot === null) return
        const sessionId = await waitFor(
          () => {
            const current = currentSessionId()
            if (current === undefined || current === '') return undefined
            if (current === snapshot.beforeSession) return undefined
            return current
          },
          OPEN_TIMEOUT_MS,
          isDisposed,
        )
        if (sessionId === undefined) {
          if (pending === snapshot) pending = null
          return
        }

        // Give the transcript a moment to mount before resolving anchors.
        await frame()
        await frame()

        try {
          await jumpToMatch(ctx, sessionId, snapshot.query, isDisposed)
        } catch {
          // A failed jump must never break the host UI.
        }
        if (pending === snapshot) pending = null
      }

      document.addEventListener('click', onClick, true)

      const dispose = () => {
        if (disposed) return
        disposed = true
        document.removeEventListener('click', onClick, true)
        disconnectPlaceholder()
        delete window.__dshGuiSearchChat
        removeStyle()
        pending = null
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, `${PLUGIN_ID}: client`)
      } else if (typeof ctx.on === 'function') {
        ctx.on('dispose', dispose)
      }
    }

    return module.exports
  },
})
