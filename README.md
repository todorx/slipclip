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

## Third-party code

`notion-clipper-source/vendor/` holds unmodified release builds of [@mozilla/readability](https://github.com/mozilla/readability) 0.6.0 (Apache-2.0) and [turndown](https://github.com/mixmark-io/turndown) 7.2.0 (MIT).

Not affiliated with Notion Labs, Inc.
