# SlipClip

Clip the article, not the furniture. A Firefox extension that extracts the readable part of a page and files it into Notion as Markdown, plus the site that documents it.

- **[notion-clipper-source/](notion-clipper-source/)** — the extension. No build step; load `manifest.json` directly.
- **[notion-clipper-site/](notion-clipper-site/)** — the landing page and privacy policy, served at [slipclip.todorx.dev](https://slipclip.todorx.dev).

## Deploying the site

`.github/workflows/deploy.yml` publishes `notion-clipper-site/` to GitHub Pages on every push to `main` that touches it, and can be run by hand from the Actions tab.

Two one-time settings on GitHub before the first run:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Not "Deploy from a branch" — the workflow uploads an artifact, and the branch setting ignores it.
2. **Settings → Pages → Custom domain: `slipclip.todorx.dev`**, then tick *Enforce HTTPS* once the certificate is issued.

DNS, on the `todorx.dev` zone:

```
CNAME   slipclip   todorx.github.io
```

`notion-clipper-site/CNAME` carries the same hostname so a redeploy cannot drop it.

## Testing the extension

```bash
cd notion-clipper-source && node test.mjs
```

Runs on bare Node 18+ with no dependencies. `.github/workflows/test.yml` runs it on every push that touches the extension.

## Packaging a build

The extension is the zip of `notion-clipper-source/`, with `manifest.json` at the root of the archive:

```bash
npx -y web-ext build --source-dir notion-clipper-source --artifacts-dir dist --overwrite-dest
```

Release Firefox refuses an unsigned package, so the file that goes on a GitHub release has to come back signed from addons.mozilla.org first. Either upload `dist/*.zip` there by hand, or sign it from the command line with [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/):

```bash
npx -y web-ext sign --source-dir notion-clipper-source --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

`--channel unlisted` returns a signed `.xpi` for self-distribution without a public AMO listing; `--channel listed` submits it for review instead. The site's download button points at the releases page, so publish the signed file there before announcing it.

Firefox 140 is the floor (`strict_min_version`). Two things set it: Manifest V3 host permissions are only granted at install from 127 onward - on 126 and earlier the extension installs but can never reach `mcp.notion.com` - and `data_collection_permissions` landed in 140. Firefox for Android reads that key only from 142, so leave the Android listing off on AMO.

## Third-party code

`notion-clipper-source/vendor/` holds unmodified release builds of [@mozilla/readability](https://github.com/mozilla/readability) 0.6.0 (Apache-2.0) and [turndown](https://github.com/mixmark-io/turndown) 7.2.0 (MIT). Both licenses are reproduced in [notion-clipper-source/THIRD-PARTY-NOTICES.md](notion-clipper-source/THIRD-PARTY-NOTICES.md), which ships inside the extension. SlipClip's own code is MIT, see [LICENSE](LICENSE).

`notion-clipper-site/og.png` is rendered from `og.svg` — social scrapers do not read SVG:

```bash
cd notion-clipper-site && npx -y @resvg/resvg-js-cli og.svg og.png --font-serif-family Georgia
```

Not affiliated with Notion Labs, Inc.
