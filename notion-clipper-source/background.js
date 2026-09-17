import { signIn, signOut, accessToken } from "./auth.js";

// Notion's MCP server implements the spec's DNS-rebinding guard and rejects
// any browser origin ("Invalid Origin: <extension uuid>"). Desktop MCP clients
// send no Origin at all, so strip ours - scoped to this one host.
browser.webRequest.onBeforeSendHeaders.addListener(
  ({ requestHeaders }) => ({
    requestHeaders: requestHeaders.filter((h) => h.name.toLowerCase() !== "origin")
  }),
  { urls: ["https://mcp.notion.com/*"] },
  ["blocking", "requestHeaders"]
);

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
