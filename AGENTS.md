# AGENTS.md

SlipClip — Firefox + Chrome extension (`notion-clipper-source/`) + static site (`notion-clipper-site/`). No build step, no package.json, no dependencies.

## Commands

- Test extension: `cd notion-clipper-source && node test.mjs` (Node 18+, no deps; CI uses Node 22 — `.github/workflows/test.yml`, runs only when `notion-clipper-source/**` changes).
- Load extension (Firefox): `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `notion-clipper-source/manifest.json`. Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `notion-clipper-source/`.
- Preview site: `python -m http.server 4173 --directory notion-clipper-site` (mirrors `.claude/launch.json`).

## Extension architecture (`notion-clipper-source/`)

- `auth.js` — OAuth 2.1 with PKCE + dynamic client registration (RFC 7591, `token_endpoint_auth_method: "none"`) against `https://mcp.notion.com`. There is no backend/secret by design; do not "fix" auth by switching to Notion REST OAuth (it requires `client_secret`, unusable from a public client).
- `background.js` (MV3 module service worker) — owns auth and highlight capture. The popup is destroyed when focus moves to the auth window, killing the token exchange mid-flight, so sign-in must stay in the background worker; the popup only messages it. Also strips the `Origin` header for `https://mcp.notion.com/*` via the DNR rule in `rules.json` — the MCP server's DNS-rebinding guard rejects browser origins.
- `extract.js` — runs inside the page via `scripting.executeScript`, which serializes the function source. `extractPage()` must not reference anything outside itself; Readability/turndown are injected as files first and exist only as globals.
- `mcp.js` — the MCP transport (`mcpTool`, `parseResults`, `normalizeId`, `unwrapPayload`, `errorText`), shared by the popup, the options page and the background worker. One session per tool call, on purpose.
- `popup.js` — orchestration + pure helpers, with highlights in a `<details>` disclosure below the clip button — one pane, no tab state to track. Creates pages with the `notion-create-pages` MCP tool (takes Markdown directly, not block JSON); append uses `notion-update-page` / `insert_content`. Append is disabled for databases. Save-as mode resets to "new page" on every popup open — never make it sticky.
- `highlights.js` — the highlights store and every Notion-shaped decision, all pure and DOM-free: `canonicalUrl`, `addHighlight` (dedupes on the way in), `applyMapping`, `parseProperties`, `matchProperties`, `parseFetchKind`, `highlightsMarkdown`, `flushPending`. `flushPending` takes the writer as a callback, so a page destination changes only which MCP call goes inside it. A passage is capped at 2000 characters (Notion's rich-text limit) at capture; a column named `URL` or `id` must be written as `userDefined:URL`.
- `options.js` / `options.html` — the highlights destination, which is either a database (one row per passage, columns mapped) or a page (passages appended as quotes, nothing to map). `destinations.highlights.kind` discriminates; a config stored before pages were allowed has no `kind` and can only have been a database. The passage must map to the title column; Notion requires a title on every row.
- `vendor/` (`Readability.js`, `turndown.js`, `turndown-plugin-gfm.js`) — unmodified upstream release builds. Never edit; licenses live in `THIRD-PARTY-NOTICES.md`.
- `test.mjs` imports `auth.js`, `mcp.js`, `popup.js`, `extract.js` and `highlights.js` under plain Node (no DOM). Keep those modules free of top-level `document`/`browser` access or tests break. `options.js` is not imported — it touches the DOM at top level.
- Two cross-browser traps, both already fixed — do not reintroduce them: Chrome does not support returning a promise from `runtime.onMessage` (crbug 1185241), so replies go through `sendResponse` with `return true`; and Firefox for Android has neither `contextMenus` nor `commands`, so both are registered behind a check — touching a missing namespace at top level throws and takes the worker, and with it sign-in, down with it.
- `notion-clipper-site/privacy.html` enumerates what is stored locally and what is sent to Notion. Anything new in `storage.local`, or any new call, belongs in both lists.
- Manifest is cross-browser MV3 (`background.service_worker` + `declarativeNetRequest`; Chrome ignores `browser_specific_settings.gecko`). The gecko block (`id: slipclip@todorx.dev`, `strict_min_version: 140.0`, `data_collection_permissions`) is load-bearing for Firefox.

## Site deploys (`.github/workflows/deploy.yml`)

- Pushes to `main` touching `notion-clipper-site/` publish to GitHub Pages; manual run via Actions tab. Requires repo setting Pages → Source: **GitHub Actions** (not branch deploy) + custom domain `slipclip.todorx.dev` with Enforce HTTPS.
- `notion-clipper-site/CNAME` must keep the hostname or redeploys drop the domain. `.nojekyll` is required for asset passthrough.
- `dist/` (`*.xpi`, `web-ext-artifacts/`) is gitignored build output — never commit it.
