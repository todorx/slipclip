// OAuth 2.1 against Notion's MCP server: dynamic client registration + PKCE.
// Runs in the background page only - a browser action popup is destroyed the
// moment focus moves to the auth window, which kills the token exchange.

const MCP = "https://mcp.notion.com";

if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined")
  globalThis.browser = globalThis.chrome;

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

export const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function clientId() {
  const { client_id } = await browser.storage.local.get("client_id");
  if (client_id) return client_id;
  const r = await fetch(`${MCP}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "SlipClip for Notion",
      redirect_uris: [browser.identity.getRedirectURL()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  const reg = await r.json().catch(() => ({}));
  if (!r.ok || !reg.client_id) throw new Error(reg.error_description || `Registration failed (${r.status})`);
  await browser.storage.local.set({ client_id: reg.client_id });
  return reg.client_id;
}

// Notion rotates the refresh token on every use, so persist the new pair
// before returning - a later failure must not strand a revoked token.
async function tokenRequest(params) {
  const r = await fetch(`${MCP}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || `Token request failed (${r.status})`);
  await browser.storage.local.set({
    access_token: d.access_token,
    expires_at: Date.now() + ((d.expires_in ?? 3600) * 1000) - 60000,
    ...(d.refresh_token ? { refresh_token: d.refresh_token } : {})
  });
  return d.access_token;
}

export async function signIn() {
  await browser.storage.local.remove("auth_error");
  const client_id = await clientId();
  const redirect_uri = browser.identity.getRedirectURL();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = `${MCP}/authorize?` + new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: "code",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256"
  });

  const redirect = await webAuthFlow(url);
  const q = new URL(redirect).searchParams;
  if (q.get("state") !== state) throw new Error("State mismatch - sign-in aborted.");
  if (q.get("error")) throw new Error(q.get("error_description") || q.get("error"));
  const code = q.get("code");
  if (!code) throw new Error("No authorization code returned.");
  await tokenRequest({ grant_type: "authorization_code", code, client_id, redirect_uri, code_verifier: verifier });
}

export async function signOut() {
  await browser.storage.local.remove(["access_token", "refresh_token", "expires_at", "auth_error"]);
}

export async function accessToken() {
  const s = await browser.storage.local.get(["access_token", "refresh_token", "expires_at", "client_id"]);
  if (!s.access_token) throw new Error("Not connected.");
  if (s.expires_at && Date.now() < s.expires_at) return s.access_token;
  if (!s.refresh_token) throw new Error("Session expired - connect again.");
  return tokenRequest({ grant_type: "refresh_token", refresh_token: s.refresh_token, client_id: s.client_id });
}
