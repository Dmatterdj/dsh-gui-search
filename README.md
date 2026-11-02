# dsh-gui-search

Search **inside** your DeepSeek Harness sessions from the sidebar search box — and jump straight to the message that matched.

The stock sidebar search box only matches session **titles**. This plugin makes the same box search session **content**, in any language, and then scrolls to and highlights the exact matching message.

## What it does

| | Stock | With this plugin |
|---|---|---|
| Matches session titles | ✅ | ✅ |
| Matches message content | ❌ | ✅ |
| Chinese / Japanese / Korean substring | ❌ | ✅ |
| 1–2 character queries | ❌ | ✅ |
| Jumps to the matched message | ❌ | ✅ |
| Highlights the match | ❌ | ✅ |

## Why the built-in content index cannot find Chinese

DSH ships an optional SQLite FTS5 index (`@deepseek-ai/dsh-session-query-sqlite`). Its virtual tables are created with:

```sql
CREATE VIRTUAL TABLE persisted_docs USING fts5(..., tokenize = 'unicode61')
```

`unicode61` does not segment CJK. A run of consecutive Chinese characters becomes **one token**, and the caller wraps the query as a single quoted FTS5 phrase. So searching `搜索` never matches a message containing `全文搜索` — the index holds the whole run as one token and the query asks for a different one.

This was measured, not assumed. On a real index:

| query | FTS5 `unicode61` | literal substring |
|---|---|---|
| `zstd` | 1 hit | 1 hit |
| `指纹` | **0 hits** | 1 hit |
| `插件` | **0 hits** | 1 hit |
| `插件冲突` | **0 hits** | 1 hit |
| `帧` (single char) | **0 hits** | 1 hit |

This plugin scans literal substrings instead, so every one of those queries works.

## How it works

Two halves:

**Host half** (`index.js`) replaces exactly one method, `sessionQuery.searchSessions`. Documents are read through the inherited `sessionQuery.filterEvents()`, so authorization, live-vs-persisted preference and text extraction stay in core code. Titles, exact reads, traces and filters are untouched — nothing else on the service changes behavior.

**Client half** (`lib/client.js`) makes the jump work. The stock result row carries only a session id, so selecting a result opens the session but never navigates to the matching message. This half listens for the result-row click, remembers the query, then:

1. asks the host which `seq` matched (`GET /api/gui-search/locate`);
2. pages older history in until that `seq` enters the loaded window;
3. resolves the DOM row, scrolls it clear of the composer, flashes it and highlights every occurrence.

A freshly opened session auto-scrolls itself to the bottom, which undoes the first scroll attempt. The jump retries until the row stays put inside a safe band above the composer, so it wins that race deterministically.

## Install

```bash
dsh plugin add dsh-gui-search
```

Or add it to your profile's bundle list:

```yaml
# cordis.patch.yml
- insert:
    - id: gui-search
      name: 'dsh-gui-search'
      config:
        debug: false
```

## Configuration

| key | type | default | meaning |
|---|---|---|---|
| `debug` | boolean | `false` | Append matching/activation logs to `$DSH_HOME/gui-search.log`. Never changes search behavior. |

## Routes

One read-only route, fenced to same-origin loopback callers:

| route | purpose |
|---|---|
| `GET /api/gui-search/health` | `{ ok, name, sessions, installed }` — confirms the patch is live and how many sessions are cached |
| `GET /api/gui-search/locate?session=<id>&q=<query>` | `{ ok, seq, time, type, snippet, count }` — the best matching message position inside one session |

`locate` returns conversation text in `snippet`, which is why it is fenced: the `Host` header must be loopback, `Sec-Fetch-Site: cross-site` is rejected, and a present `Origin` must equal the request `Host`.

## Behavior notes

- **Terms are ANDed.** `插件 冲突` requires both substrings. Whitespace separates terms.
- **Case-insensitive**, and works on any script, including single characters.
- **Results are ranked** by total occurrence count, then most recent, then newest session.
- **Documents are cached per session** and invalidated when the session advances. A background warm-up populates the cache shortly after startup so the first query is already fast.
- **Empty queries and title-only callers** fall through to the original implementation unchanged.
- **No tools are registered.** This is deliberate: registering a tool like `session_search` collides with `@deepseek-ai/dsh-tool-session-query` and disables the built-in session tools. This plugin adds zero tools, so it cannot conflict with any other plugin.

## Compatibility

- Requires DSH `>=0.2.1-rc.2 <0.3.0`.
- Tested on client `0.2.1-rc.5` (host protocol 4).
- Zero runtime dependencies; no build step.
- Does not modify `app.asar` and does not read session files directly.

## Limitations

- The exact-position jump relies on an internal chat snapshot. On a build that does not expose it, the plugin falls back to locating the first text node containing the query, which can select the wrong row when the same phrase repeats inside one session. Search results themselves are unaffected.
- Session-level filters (`sessionFilters`) are delegated to the original implementation rather than reimplemented, so those requests keep stock title-only semantics.
- Only `user/message` and `assistant/message` are indexed; tool output and reasoning are not.

## License

MIT

---

# 中文说明

在侧边栏搜索框里搜索会话**正文内容**，而不只是会话**标题**，并且能直接跳转定位到命中的那一条消息。

## 为什么内置的全文索引搜不到中文

DSH 自带的 SQLite FTS5 索引建表时用的是 `tokenize = 'unicode61'`。这个分词器不切分中日韩文字：**一串连续汉字会被当成一个 token**，而查询又被整体包成一个 FTS5 短语。所以搜 `搜索`，永远匹配不到包含 `全文搜索` 的消息。

这是实测结果，不是推测：

| 查询 | FTS5 `unicode61` | 字面子串 |
|---|---|---|
| `zstd` | 1 命中 | 1 命中 |
| `指纹` | **0 命中** | 1 命中 |
| `插件` | **0 命中** | 1 命中 |
| `插件冲突` | **0 命中** | 1 命中 |
| `帧`（单字） | **0 命中** | 1 命中 |

本插件改为字面子串扫描，上面每一条都能搜到。

## 两部分组成

**Host 半部分**只替换 `sessionQuery.searchSessions` 这一个方法。文档仍然通过继承来的 `sessionQuery.filterEvents()` 读取，所以授权、活跃/持久偏好、正文提取全部留在内核代码里。标题、精确读取、trace、过滤器都保持原样。

**Client 半部分**负责定位跳转。官方搜索结果行只带会话 ID，不带消息位置，所以点结果只会打开会话、不会跳到命中处。这部分接住结果行的点击，记住查询词，然后：

1. 向 Host 询问命中的 `seq`；
2. 向前翻页直到该 `seq` 进入已加载窗口；
3. 找到对应的 DOM 行，滚动到不被输入框遮挡的位置，闪烁并高亮全部命中。

新打开的会话会自动滚到底部，会覆盖掉第一次滚动。跳转会持续重试，直到该行稳定停在输入框上方的安全区内。

## 安装

```bash
dsh plugin add dsh-gui-search
```

## 设计取舍

- **不注册任何工具。** 这是刻意的：注册 `session_search` 这类工具会和 `@deepseek-ai/dsh-tool-session-query` 撞名，导致内置会话工具全部失效。本插件零工具，因此不会与任何插件冲突。
- **只替换一个方法**，不做整体截胡，上游改动时不易崩。
- **零运行时依赖，无构建步骤。**

## 许可

MIT
