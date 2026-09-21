<p align="center">
  <img src="slipclip-logo.png" width="180" alt="SlipClip logo" />
</p>

<h1 align="center">SlipClip for Notion</h1>

<p align="center">
  Clip the article, not the furniture. A Firefox extension that extracts the readable part of a page and files it into Notion as Markdown.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.mozilla.org/firefox/"><img src="https://img.shields.io/badge/Firefox-140%2B-orange?logo=firefox" alt="Firefox 140+" /></a>
  <a href="https://github.com/todorx/slipclip/actions/workflows/test.yml"><img src="https://github.com/todorx/slipclip/actions/workflows/test.yml/badge.svg" alt="Test extension" /></a>
  <a href="https://slipclip.todorx.dev"><img src="https://img.shields.io/badge/site-slipclip.todorx.dev-blue" alt="Site" /></a>
</p>

<p align="center">
  <a href="https://slipclip.todorx.dev">Website</a> ·
  <a href="notion-clipper-source/">Extension</a> ·
  <a href="notion-clipper-site/privacy.html">Privacy</a> ·
  <a href="#quick-start">Quick start</a>
</p>

## Features

- One-click clip: URL + title + selection or full readable article as Markdown.
- Smart extraction: articles, YouTube/video pages, index/listing pages, or plain links — picked from JSON-LD / `og:type`.
- Sign in with Notion, nothing to paste — OAuth 2.1 + PKCE via Notion's hosted MCP server, no backend or secret.
- Save as new page/row or append to an existing page; inline databases discovered automatically.
- No build step, no dependencies. Just load `manifest.json`.

## Quick start

1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `notion-clipper-source/manifest.json`.
2. Click the add-on → **Connect Notion** → choose which pages to share.
3. Pick a destination → Clip.

## Usage

**How** picks what happens at the destination: *New page inside* creates a child page (or a row, if the destination is a database), *Append to the end* adds the clip to the bottom via `notion-update-page` / `insert_content`. Appending is disabled for databases, which cannot hold loose blocks.

The dropdown loads recent pages on open (`notion-list-recent-pages`); typing searches the workspace (`notion-search`). Selecting a page also lists inline databases inside it, indented with `↳`. Both only ever see pages shared during consent. Pasting a link still works for anything the list misses.

**Save as** resets to *A new page inside* every popup open — appending is a per-clip decision, never sticky.

A text selection outranks everything: highlight something and the clip is that quote alone. Article bodies cap at 60,000 characters and are marked when truncated.

## How it works

- Auth talks to Notion's hosted MCP server (`https://mcp.notion.com`) with dynamic client registration (RFC 7591, `token_endpoint_auth_method: "none"`) — designed for public clients. Each install registers as its own OAuth client. Notion's REST OAuth is intentionally avoided: it needs a `client_secret` a public extension cannot hold.
- Sign-in runs in the background page (`auth.js`), not the popup — Firefox destroys popups when focus moves to the auth window, killing the exchange mid-flight.
- Pages are created with the `notion-create-pages` MCP tool (Markdown in, no block JSON).
- Extraction is [@mozilla/readability](https://github.com/mozilla/readability) 0.6.0 + [turndown](https://github.com/mixmark-io/turndown) 7.2.0, vendored unmodified in `vendor/`. A page counts as an index when Readability finds under 600 characters of prose (link text excluded).

See [notion-clipper-source/README.md](notion-clipper-source/README.md) for the full technical notes.

## Repo layout

- **[notion-clipper-source/](notion-clipper-source/)** — the extension. No build step; load `manifest.json` directly.
- **[notion-clipper-site/](notion-clipper-site/)** — landing page + privacy policy, served at [slipclip.todorx.dev](https://slipclip.todorx.dev).

## Testing

```bash
cd notion-clipper-source && node test.mjs
```

Bare Node 18+, no dependencies. `.github/workflows/test.yml` runs it on every push touching the extension.

## Packaging

The extension is the zip of `notion-clipper-source/`, with `manifest.json` at the archive root:

```bash
npx -y web-ext build --source-dir notion-clipper-source --artifacts-dir dist --overwrite-dest
```

Release Firefox needs a signed package, so the file on a GitHub release must come back from addons.mozilla.org. Upload `dist/*.zip` by hand, or sign with [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/):

```bash
npx -y web-ext sign --source-dir notion-clipper-source --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

`--channel unlisted` returns a self-distributable `.xpi`; `--channel listed` submits for review. The site's download button points at releases, so publish the signed file there first.

Firefox 140 is the floor (`strict_min_version`): host permissions grant-at-install needs 127+, `data_collection_permissions` needs 140. Firefox for Android reads that key only from 142, so leave the Android listing off on AMO.

## Site deploy

`.github/workflows/deploy.yml` publishes `notion-clipper-site/` to GitHub Pages on pushes to `main` touching it (or by hand from Actions). One-time setup:

1. **Settings → Pages → Source: GitHub Actions** (not branch deploy).
2. **Settings → Pages → Custom domain: `slipclip.todorx.dev`**, Enforce HTTPS once issued.

DNS on `todorx.dev`: `CNAME slipclip → todorx.github.io`. `notion-clipper-site/CNAME` pins the hostname so redeploys keep it. `og.png` is rendered from `og.svg` (scrapers don't read SVG):

```bash
cd notion-clipper-site && npx -y @resvg/resvg-js-cli og.svg og.png --font-serif-family Georgia
```

## Privacy

Tokens live in `storage.local` (~8h access, ~180d refresh, rotated on use). The manifest declares `data_collection_permissions` (`websiteContent`, `searchTerms`) — shown on the AMO install prompt. Full policy: [privacy.html](notion-clipper-site/privacy.html).

## Third-party code

`vendor/` holds unmodified release builds; licenses in [THIRD-PARTY-NOTICES.md](notion-clipper-source/THIRD-PARTY-NOTICES.md) (ships inside the extension). SlipClip's own code is MIT — see [LICENSE](LICENSE).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Notion Labs, Inc.
