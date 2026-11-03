# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-11-02

### Added

- Literal, case-insensitive substring search over session message content from
  the sidebar search box, in every language including single-character CJK
  queries.
- Jump-to-hit: selecting a result opens the session, pages older history in
  until the matching message is loaded, scrolls it clear of the composer,
  flashes it and highlights every occurrence.
- Folded reasoning blocks are expanded automatically so a hit inside them can
  be reached.
- Read-only `GET /api/gui-search/locate` route, fenced to same-origin loopback
  callers.
- Background warm-up caches extracted messages per session so the first query
  is already fast.

### Why

The built-in SQLite FTS5 index tokenizes with `unicode61`, which does not
segment CJK: a run of Chinese characters becomes one token, so content search
returns 0 hits for queries like `指纹`, `插件`, `插件冲突` or any single
character. This plugin scans literal substrings instead.

### Notes

- Registers zero tools, so it cannot collide with
  `@deepseek-ai/dsh-tool-session-query`.
- Zero runtime dependencies, no build step.
