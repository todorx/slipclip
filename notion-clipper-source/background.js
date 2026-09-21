import { signIn, signOut, accessToken } from "./auth.js";

if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined")
  globalThis.browser = globalThis.chrome;

// Origin strip lives in rules.json (DNR modifyHeaders) - webRequestBlocking
// is unavailable in Chrome MV3, so no listener here. Service workers are
// non-persistent: `pending` dedups within one lifetime only; the sign-in
// outcome persists via storage.local either way.

// The popup that sent this message is gone by the time the flow finishes, so
// the outcome goes to storage: the next popup open reads it.
let pending = null;

function startSignIn() {
  pending ??= signIn()
    .then(() => ({ ok: true }))
    .catch(async (e) => {
      console.error("sign-in failed:", e);
      await browser.storage.local.set({ auth_error: e.message });
      return { ok: false, error: e.message };
    })
    .finally(() => { pending = null; });
  return pending;
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "signin":
      return startSignIn();
    case "signout":
      return signOut().then(() => ({ ok: true }));
    case "token":
      return accessToken()
        .then((token) => ({ ok: true, token }))
        .catch((e) => ({ ok: false, error: e.message }));
  }
});
