# SlipClip for Notion

Clips the current page URL + title + selected text to Notion. Sign in with Notion — no integration token to create, copy, or paste.

## How it authenticates

Notion's REST OAuth requires a `client_secret` at the token endpoint and does not support PKCE, so a browser extension cannot complete it without a hosted proxy holding that secret.

This extension talks to Notion's hosted MCP server (`https://mcp.notion.com`) instead. That endpoint implements OAuth 2.1 with PKCE and dynamic client registration (RFC 7591, `token_endpoint_auth_method: "none"`), which is designed for public clients — no secret, no backend. Each install registers itself as its own OAuth client and stores the resulting `client_id`.

Pages are created with the `notion-create-pages` MCP tool, which accepts markdown directly rather than Notion block JSON.

The sign-in runs in the background page (`auth.js`), not the popup. Firefox destroys a browser action popup as soon as focus moves to the auth window, which would kill the token exchange mid-flight; the popup only sends a message and reads the result when reopened.

## What gets clipped

The page says what it is — JSON-LD `@type` and `og:type` — and that decides how much is taken:

| Page | Clipped |
|---|---|
| Article / BlogPosting / NewsArticle | site, author, date, then the full article body as Markdown |
| VideoObject (YouTube and friends) | title, channel, date, duration, description — the body walker never runs. Read from JSON-LD or microdata, since YouTube uses the latter |
| index / listing pages | blurb plus the links in the main content, up to 150, deduplicated |
| anything else | link and description |

A page counts as an index when Readability finds under 600 characters of prose — measured with link text removed, so a page made of links reads as short no matter how many words its anchors hold.

**Save as** resets to *A new page inside* every time the popup opens. Appending is a per-clip decision, never a sticky one.

A text selection outranks all of it: highlight something and the clip is that quote alone. Article bodies are capped at 60,000 characters and marked when truncated.

Tables, strikethrough and task lists arrive as real Markdown, and images resolve through the lazy-loading `data-*` attributes most sites hide them in rather than the placeholder left in `src`.

Extraction is [`@mozilla/readability`](https://github.com/mozilla/readability) (Apache-2.0), [turndown](https://github.com/mixmark-io/turndown) (MIT), and [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) (MIT, for tables, strikethrough and task lists — core turndown has none of them), vendored in `vendor/` and injected into the page alongside `extract.js`. All three are unmodified release builds.

A `lazyImage` rule sits on top of the converter: most sites keep the real image in a `data-*` attribute and serve a placeholder in `src`, which the built-in rule reads blindly. Their licenses are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Highlights

A second way in: instead of clipping a page, save the passage you are reading and deal with it later.

Select text, then **Save highlight to SlipClip** in the context menu or `Alt+Shift+H`. Capture runs in the background worker — the popup is destroyed the moment focus moves, and both triggers have to work with no popup open. The toolbar badge is the only feedback: it counts what is waiting, and a duplicate does not increment it. Neither `contextMenus` nor `commands` exists on Firefox for Android, so both are registered behind a check and highlights are desktop-only there.

Highlights live in `storage.local` until they reach Notion. Identity is the canonical URL (fragment and tracking parameters stripped, `www.` and host case normalised) plus the normalised passage, so one article shared through three links is one source. Passages are capped at 2000 characters — Notion's rich-text limit — and marked when the cap fired.

The queue drains when the popup opens, whichever tab you land on, in chunks of 50. `synced` is stamped only after `notion-create-pages` returns, so a popup closed mid-flight retries cleanly; the reverse window re-creates a row rather than losing one. A failure leaves the queue intact and the sync control becomes **Retry**.

The library is a `<details>` disclosure at the bottom of the popup, not a second tab — clipping and highlights are one job, and the collapsed summary costs one line that carries the waiting count. It opens itself when a flush fails, so a stuck queue is never hidden behind a click.

**Open Settings** picks the destination — recents, search, or a pasted link — and it can be either kind:

- **A database** gets one row per passage. Its columns are read from the `CREATE TABLE` block `notion-fetch` returns and a mapping is proposed for you to confirm. The passage has to be the title column, because Notion requires a title on every row. A column named `URL` or `id` collides with a reserved name and is written as `userDefined:URL`. **Create a database for me** makes one with a schema we own, already mapped.
- **A page** gets the passages appended to its end via `notion-update-page` / `insert_content` — an H2 per source, then the passages as blockquotes. Nothing to map, so it saves the moment you pick it. Each sync appends a fresh section, so two syncs from one article leave two headings; merging would mean fetching the page and inserting mid-document.

Which one you picked is read from `metadata.type` on the fetch, not from whether a `collection://` id turns up in the payload — a page holding an inline database carries one too.

## Setup

1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.
2. Click the addon → **Connect Notion** → choose which pages to share on Notion's consent screen.
3. Pick a destination from the dropdown → Clip.
4. For highlights: **Open Settings** → pick or create the destination database → save the mapping.

**How** picks what happens at the destination: *New page inside* creates a child page (or a row, if the destination is a database), *Append to the end* adds the clip to the bottom of the existing page via `notion-update-page` / `insert_content`. Appending is disabled for databases, which cannot hold loose blocks.

The dropdown loads your recent pages on open (`notion-list-recent-pages`); typing in the search box queries the workspace (`notion-search`). Selecting a page also fetches it and lists any inline databases inside it, indented with `↳` — inline databases live in a page's content and never appear in recents or search on their own. Both only ever see pages you shared during consent. Pasting a link still works for anything the list misses.

## Tests

```
node test.mjs
```

Covers the PKCE S256 derivation against the RFC 7636 test vector, the Android sign-in resume guard, Notion URL → UUID normalization, the markdown body builder, the lazy-image rule, and the whole highlights core — canonicalisation, dedupe, mapping, schema parsing and the flush's storage choreography. Node 18+, no dependencies.

## Notes

- Access tokens last ~8 hours; refresh tokens up to 180 days. Notion rotates the refresh token on every use, so the extension persists the new pair before using the new access token.
- Tokens live in `storage.local`, same as the pasted token did.
- Notion's MCP server is in beta. Tool schemas are not version-pinned the way `Notion-Version: 2022-06-28` pins the REST API, so a schema change upstream can require a patch here.
- Firefox 140+. Manifest V3 host permissions are only granted at install from 127 onward - on 126 and earlier Firefox installs the extension without ever granting `https://mcp.notion.com/*`, and every request to Notion fails. `data_collection_permissions` then pushes the floor to 140, the version that reads it. `strict_min_version` keeps everything older out.
- The manifest declares `data_collection_permissions` (`websiteContent`, `searchTerms`) - what the clip and the destination search send to Notion. AMO requires the key on every new extension, and Firefox shows it on the install prompt.
- Firefox + Chrome from one codebase (MV3 service-worker background, DNR Origin strip, `browser`/`chrome` shim); the redirect URL is handled by dynamic registration either way.
