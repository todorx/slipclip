# SlipClip for Notion (Firefox)

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

Extraction is [`@mozilla/readability`](https://github.com/mozilla/readability) (Apache-2.0) plus [turndown](https://github.com/mixmark-io/turndown) (MIT), vendored in `vendor/` and injected into the page alongside `extract.js`. Both are unmodified release builds.

## Setup

1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.
2. Click the addon → **Connect Notion** → choose which pages to share on Notion's consent screen.
3. Pick a destination from the dropdown → Clip.

**How** picks what happens at the destination: *New page inside* creates a child page (or a row, if the destination is a database), *Append to the end* adds the clip to the bottom of the existing page via `notion-update-page` / `insert_content`. Appending is disabled for databases, which cannot hold loose blocks.

The dropdown loads your recent pages on open (`notion-list-recent-pages`); typing in the search box queries the workspace (`notion-search`). Selecting a page also fetches it and lists any inline databases inside it, indented with `↳` — inline databases live in a page's content and never appear in recents or search on their own. Both only ever see pages you shared during consent. Pasting a link still works for anything the list misses.

## Tests

```
node test.mjs
```

Covers the PKCE S256 derivation against the RFC 7636 test vector, Notion URL → UUID normalization, and the markdown body builder. Node 18+, no dependencies.

## Notes

- Access tokens last ~8 hours; refresh tokens up to 180 days. Notion rotates the refresh token on every use, so the extension persists the new pair before using the new access token.
- Tokens live in `storage.local`, same as the pasted token did.
- Notion's MCP server is in beta. Tool schemas are not version-pinned the way `Notion-Version: 2022-06-28` pins the REST API, so a schema change upstream can require a patch here.
- Firefox only. A Chrome port needs `chrome.*` aliases; the redirect URL is handled by dynamic registration either way.
