# SlipClip Chrome + Firefox MV3 — Design Spec

Date: 2026-09-21. Single codebase, no build step, unpacked-loadable in both browsers today, CWS-ready for later.

## Intent

Same `notion-clipper-source/` loads in Firefox (`about:debugging`) and Chrome (`chrome://extensions`, developer mode) and clips end-to-end. Firefox behavior unchanged. No new deps, `node test.mjs` stays green.

## Approach: unified service-worker manifest

One `manifest.json` for both browsers. Firefox 140 reads MV3 service workers, so drop `background.html`/`background.page` and run `background.js` as a module service worker everywhere. Chrome ignores `browser_specific_settings.gecko`; Firefox ignores the DNR rule resource it doesn't need (guarded below).

Rejected: dual manifests + copy step (new build step, violates repo's no-build rule); Chrome fork directory (code drift, double maintenance).

## Changes

### 1. `manifest.json`

- `background`: `{ "service_worker": "background.js", "type": "module" }` (replaces `"page": "background.html"`; delete `background.html`).
- `permissions`: `["activeTab", "storage", "scripting", "identity", "declarativeNetRequest"]` — drop `webRequest`/`webRequestBlocking` (blocked in Chrome MV3, triggers CWS warnings).
- Add `declarative_net_request.rule_resources`: `[{ "id": "mcp-origin", "enabled": true, "path": "rules.json" }]`.
- Keep `host_permissions: ["https://mcp.notion.com/*"]` and the full `browser_specific_settings.gecko` block untouched.

### 2. `rules.json` (new)

One DNR `modifyHeaders` rule replacing the `webRequest.onBeforeSendHeaders` Origin strip in `background.js`:

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "modifyHeaders", "requestHeaders": [{ "header": "Origin", "operation": "remove" }] },
    "condition": { "urlFilter": "https://mcp.notion.com/*" }
  }
]
```

Same effect (desktop MCP clients send no Origin), store-safe API on both browsers. Delete the `webRequest` listener from `background.js`.

### 3. `browser`/`chrome` shim (top of `auth.js`, `background.js`, `popup.js`)

```js
if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined")
  globalThis.browser = globalThis.chrome;
```

Guarded via `globalThis` so `test.mjs` under Node (neither defined) keeps passing. No top-level `document`/`browser` access added.

### 4. `auth.js` — promise-tolerant `launchWebAuthFlow`

Chrome's `chrome.identity` is callback-style; Firefox's `browser.identity` returns a promise. Wrap one place:

```js
// Single call: Firefox returns a promise (callback ignored), Chrome
// returns undefined and invokes the callback. Promise ignores the loser.
function webAuthFlow(url) {
  return new Promise((resolve, reject) => {
    const maybe = browser.identity.launchWebAuthFlow({ url, interactive: true }, (redirect) => {
      if (browser.runtime.lastError || !redirect)
        reject(new Error(browser.runtime.lastError?.message || "Sign-in closed."));
      else resolve(redirect);
    });
    maybe?.then?.(resolve, reject);
  });
}
```

`getRedirectURL` and dynamic client registration are unchanged — the redirect URI is registered per install either way. Token storage/rotation logic untouched.

### 5. `background.js` — service-worker safety

- Keep `runtime.onMessage` dispatch (`signin`/`signout`/`token`) as-is; service-worker modules support `import`.
- Keep in-memory `pending` dedup within one lifetime only; sign-in outcome already persists via `storage.local` (`access_token`, `auth_error`), so a worker restart mid-flow degrades to "reopen popup to see result" — same UX as today.
- No DOM, no `webRequest` references remain.

### 6. `popup.js` — no logic change

`tabs.query`, `scripting.executeScript({ func: extractPage })`, `storage`, `runtime.sendMessage` exist in both namespaces once shimmed. `extract.js` constraint (no outside references) unchanged.

## Error handling

- DNR rule missing/misfiring surfaces as today's "Invalid Origin" MCP error — no new handling; `rpc()` already throws readable messages.
- Auth window closed by user: wrapper rejects with "Sign-in closed." → stored as `auth_error`, shown on next popup open (existing path).
- Non-HTTP tabs (about:, chrome://, web store): existing "Can't read this page" error covers both browsers; wording generalized from "Firefox blocks…" to "This browser blocks…".

## Testing

1. `cd notion-clipper-source && node test.mjs` — must print `ok` (shim is Node-safe, pure helpers untouched).
2. Firefox: `about:debugging` → Load Temporary Add-on → connect, clip article + selection + append.
3. Chrome: `chrome://extensions` → Developer mode → Load unpacked → same three clips; confirm no `Origin` header via failure absence (no Invalid Origin error).
4. No console errors on popup open in either browser.

## Rollout / CWS readiness

No store submission now. When available: upload the same zip (`manifest.json` at root); DNR + `identity` + `storage`/`scripting`/`activeTab` need no extra CWS justification beyond the existing privacy note. `AGENTS.md` + source `README.md` Firefox-only lines updated to "Firefox + Chrome".
