# SlipClip Highlights — Design Spec

Date: 2026-09-21. Readwise-style highlight saving for the existing clipper: capture passages while reading, keep them locally, flush them into a Notion database.

Prerequisite: **X1 is done** (GFM tables, strikethrough, task lists, lazy images). It is unrelated to this spec; both are recorded here only so the sequencing is clear.

## Intent

Today a text selection is ephemeral: you highlight a passage, clip it, and it is gone — one clip, one passage. Readwise's actual feature is not the highlight, it is the **accumulation**: many passages per source, kept, deduped, and synced on your terms.

Success is: highlight several passages across an article while reading, close everything, and later find all of them in one Notion database with source, author, and date attached — without ever opening a popup to do it.

The existing "clip this whole page wherever I point it" flow is unchanged and stays the primary action.

## Decisions

| Decision | Choice |
|---|---|
| Where highlights go | Accumulate locally, then sync into a Notion database |
| Which database | User-configured in a new options page; a custom one, or one we create |
| Capture trigger | Context menu + `Alt+Shift+H`. Not an always-on content script |
| When Notion is written | Automatically on popup open |
| MCP client | Extracted to a shared `mcp.js`, used by popup, options, and background |

Rejected: a floating in-page highlight bubble (needs broad host permissions and a content script on every site — the main reason highlighters feel invasive); live per-highlight writes (needs a retry queue, crash recovery, and background re-auth, and a silently dropped highlight is worse than a visibly queued one); auto-harvesting selections with no explicit save (captures noise, hard to trust).

## Non-goals

- **No note editor in v1.** The schema keeps a `Note` column so it never needs migrating, but the popup stays read/delete. Your own words next to a passage is what makes highlights stick, so this is the first follow-up.
- **No backend.** Unchanged and load-bearing. Defeating Cloudflare-class bot walls needs server-side fetching and proxies, which would end "sign in with Notion, nothing to paste" and rewrite the privacy policy.
- **Not in this spec:** multi-page/threaded extraction, reader view. Both are separate specs.

## Architecture

Capture runs in the **background worker**, never the popup — the same reason sign-in does. The popup is destroyed the moment focus moves, and a context-menu click or keyboard shortcut must work with no popup open at all. This is what makes silent accumulation possible.

```
capture (background)  →  storage.local  →  library (popup tab)  →  flush (popup open)  →  Notion DB
```

### Files

| File | Role |
|---|---|
| `highlights.js` (new) | The store and all pure logic. DOM-free, so `test.mjs` imports it like `popup.js` |
| `mcp.js` (new) | MCP transport moved out of `popup.js`: `parseSSE`, `rpc`, `openSession`, `callTool`, `mcpTool`, plus `normalizeId`, `parseResults`, `errorText` |
| `options.html` / `options.js` (new) | Destination database, column mapping, "create one for me" |
| `background.js` | Registers the context menu and the command; capture handler; pending-count badge |
| `popup.js` / `popup.html` | Clip / Highlights tab switch; list, delete, flush |
| `manifest.json` | `contextMenus`, `commands`, `options_ui`; version bump |
| `test.mjs` | Cover the pure helpers |

`highlights.js` exposes the whole Notion-shaped layer as pure functions:

```
canonicalUrl(url)                  → dedupe identity
addHighlight(list, record)         → { list, added }   // dedupes on the way in
pending(list)                      → unsynced only
groupBySource(list)                → one Notion call per source
applyMapping(highlight, mapping)   → Notion properties object
```

`applyMapping` is the deep one: every property-type quirk lives behind one pure function taking a highlight and a mapping. No browser, no Notion, no network — so the messiest logic is the easiest thing to test.

## Data model

`storage.local` is the source of truth until a highlight is flushed; a Notion page id marks it done.

```
highlight = { id, text, note, url, canonical, title, site, author, published,
              created, truncated, synced: null | notionPageId }
```

- `canonical` strips the fragment and tracking params and normalises host case, so two URLs of one article are one source.
- `key = hash(canonical + "\n" + normalizedText)` is the dedupe identity. `addHighlight` rejects a match and returns `added: false`.
- `text` is capped at **2000 characters** at capture. Notion limits a rich-text value to 2000; exceeding it fails or silently truncates, and a passage should never reach it. `truncated` records when the cap fired, and the library marks those highlights so a clipped passage is never mistaken for the whole one.
- `note` is always present and may be empty. An empty note is omitted when writing, never sent as `""`.

## Capture

The menu path needs **no injection at all**. `menus.OnClickData` carries `selectionText` and `pageUrl`, so it works with no `activeTab` grant and even on pages where injection is blocked. `site` derives from the hostname; `title` comes from the tab, falling back to the URL.

`Alt+Shift+H` injects once, and only to read `getSelection()`.

Metadata depth is deliberately shallow: author and publish date mean running Readability on every highlight, which is wasteful for one sentence. They stay null unless a full clip of that page already cached them.

Feedback is the **badge only** — capture has no UI. The badge shows the pending count, so a successful capture visibly increments it. A duplicate does not increment it. An empty selection via the shortcut flashes the badge; the menu cannot fire empty because it is registered with `contexts: ["selection"]`.

Writes are serialised through a promise chain, the same idiom `background.js` already uses to dedupe sign-in.

## Library

A tab in the existing popup — no second window. Highlights newest-first, grouped by source. The flush runs **on popup open**, whichever tab you land on, because the popup is the app's only surface. The sync control doubles as **Retry** when the last attempt failed, and the tab reports progress while a flush is in flight.

If no destination is configured, or Notion is not connected, the tab says so and links to the options page (`runtime.openOptionsPage`).

## Destination and mapping

Stored config:

```
destinations.highlights = {
  dataSourceId,                       // the collection:// id, not the database id
  mapping: {
    text:    { name: "Highlight", type: "title" },
    url:     { name: "URL",       type: "url" },
    created: { name: "Highlighted", type: "date" },
    …
  }
}
```

**Picking one** reuses the popup's affordance: recents (`notion-list-recent-pages`), search (`notion-search`), or paste a link.

**Create one for me** runs `notion-create-database` with a schema we own, so the zero-config path never sees a mapping form:

```sql
CREATE TABLE ("Highlight" TITLE, "Source" RICH_TEXT, "Author" RICH_TEXT,
              "Site" RICH_TEXT, "URL" URL, "Highlighted" DATE, "Note" RICH_TEXT)
```

**Auto-match proposes, the form confirms:**

| Field | Matches |
|---|---|
| `text` | the title property; else rich_text named `highlight\|quote\|passage` |
| `url` | any `url`-typed property |
| `created` | any `date`-typed property |
| `title`, `author`, `site`, `note` | rich_text named `source\|article\|book`, `author`, `site\|publication`, `note\|comment` |

**Two API gotchas the schema handles:**

1. A property named `URL` (or `id`) must be written as `userDefined:URL` — case-insensitive, so our own created schema hits this. It lives in `applyMapping` and has a test.
2. `notion-create-pages` wants `{ data_source_id }` once a database has more than one source. The existing clip path uses `{ database_id }` and works; it is left alone. Highlights fetch the schema anyway, so taking the data source id is free.

**Stale mappings are not pre-validated.** An earlier draft fingerprinted the schema and re-checked it before every write. Dropped: that is an extra `notion-fetch` on every flush to guard against what Notion already rejects — an unknown property, a deleted column, or a retyped one all return a loud validation error naming the column. So we write, and on rejection keep the queue intact, surface the error, and point at the options page. Same protection, half the calls.

## Error handling

| Situation | Behaviour |
|---|---|
| Token expired at flush | Queue intact; popup says Not connected and links to Connect |
| Destination not configured | Highlights tab links to the options page |
| Column renamed, deleted, or retyped | Notion rejects; queue intact; error names the column; link to options |
| Destination database deleted | Same path — Notion rejects, queue intact |
| Capture on a restricted page (`about:`, AMO) | Works — the menu path injects nothing |
| Empty selection via shortcut | Badge flash; nothing stored |
| Duplicate passage | Ignored; badge does not increment |

## Ceilings

Marked in code with `ponytail:` comments, each with its upgrade path.

- **At-least-once flush.** `synced` is written only after `notion-create-pages` returns, so a popup destroyed mid-call leaves the queue untouched and retries cleanly. The reverse — Notion commits, then the popup dies before `synced` is stored — re-creates those rows next open. The window is about a second and the failure mode is a visible duplicate row. Upgrade: a `Key` column plus a pre-flush `notion-query-data-sources` lookup.
- **Storage growth.** `storage.local` is capped and the cap is browser-specific — 5 MB in Firefox, 10 MB in Chrome without `unlimitedStorage`. A highlight is capped at 2000 characters and synced records are currently kept for dedupe, so Firefox fills after roughly 2.5k highlights. Upgrade: prune `text` on synced records, or request `unlimitedStorage`.
- **Date precision is day-granular.** `date:X:is_datetime` is 0. Upgrade: send an ISO timestamp with `is_datetime: 1` if time-of-day ever matters.

## Testing

All pure, in `test.mjs`, no DOM, same as the existing suite.

1. `canonicalUrl` — strips fragments and tracking params, normalises host case, keeps a meaningful query, survives non-http input.
2. `addHighlight` — dedupes identical; accepts the same passage from two URLs of one article; accepts different passages from one page; does not grow on a duplicate.
3. `pending`, `groupBySource`.
4. `applyMapping` — dynamic title name; `URL` → `userDefined:URL`; date split into `date:X:start` + `date:X:is_datetime`; unmapped fields omitted; empty note omitted rather than written as `""`; text capped at 2000.
5. `parseDataSourceId` — pulls `collection://…` from a real-shaped `notion-fetch` payload.
6. `matchProperties` — proposes url-typed for `url`, date-typed for `created`, title for `text`.

Manual, both browsers: highlight three passages in an article, confirm the badge counts them, reopen the popup, confirm the flush lands one row per highlight with correct source, URL, and date. Repeat in Firefox and Chrome.

## Sequencing

| | Step | Depends on |
|---|---|---|
| H1 | Capture — menu, shortcut, store, badge | — |
| H2 | Library tab — list, delete | H1 |
| H3 | Sync — batch flush on popup open | H2 |
| H4 | Options page — destination, mapping, create-for-me | H3 |

H1 and H2 are usable and testable with no Notion involvement. H3 can select its database with the picker the popup already has, so H4 — the most expensive part — is deferred until the flow has proven itself.

## Rollout

`contextMenus` and `commands` are new manifest permissions, so the install prompt changes and AMO re-review applies. `data_collection_permissions` is unchanged: capturing a selection is covered by the existing `websiteContent` declaration, and the destination database is chosen by the user, not discovered.

`Alt+Shift+H` is a suggested key only; rebinding lives at `about:addons` → Manage Extension Shortcuts.
