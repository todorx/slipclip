// The MCP transport, shared by the popup, the options page and the background
// worker. Auth itself lives in auth.js; this only speaks JSON-RPC over the
// bearer token background.js hands out.

if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined")
  globalThis.browser = globalThis.chrome;

export const MCP = "https://mcp.notion.com";
export const PROTOCOL_VERSION = "2025-06-18";

// Auth lives in background.js - see auth.js for why it cannot live in a popup.
export const ask = (type) => browser.runtime.sendMessage({ type });

// ponytail: 32-hex -> dashed UUID inline, no lib needed
export function normalizeId(input) {
  const m = String(input || "").match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i);
  if (!m) return null;
  const h = m[1].replace(/-/g, "").toLowerCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Both notion-search and notion-list-recent-pages answer with a JSON string
// shaped { results: [...] }. Search carries `id`; recent pages carry only `url`.
export function parseResults(text) {
  const { results } = JSON.parse(text || "{}");
  return (results || [])
    .map((r) => ({ id: r.id || normalizeId(r.url), title: r.title || "", type: r.type }))
    .filter((r) => r.id);
}

// Notion's API errors arrive as a JSON blob; the sentence worth showing is
// `message`. Anything unparseable is passed through untouched.
export function errorText(raw) {
  try { return JSON.parse(raw)?.message || raw; } catch { return raw; }
}

// A tool result is either markup already, or a JSON blob whose `text` holds it.
// Callers that parse markup should start here.
export function unwrapPayload(raw) {
  try {
    const payload = JSON.parse(raw);
    // Normally the markup is under `text`; stringify covers it moving.
    return typeof payload?.text === "string" ? payload.text : JSON.stringify(payload).replace(/\\"/g, '"');
  } catch { return String(raw ?? ""); }
}

// ---------- MCP transport ----------

// ponytail: one JSON-RPC response per POST. Real SSE framing only if Notion
// starts streaming several messages per request.
function parseSSE(text) {
  const last = text.split(/\r?\n\r?\n/).filter((b) => b.includes("data:")).at(-1) || "";
  const data = last.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
  return data ? JSON.parse(data) : {};
}

async function rpc(token, sessionId, msg) {
  const r = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify(msg)
  });
  const sid = r.headers.get("Mcp-Session-Id") || sessionId;
  if (r.status === 401) throw new Error("Notion rejected the session - disconnect and connect again.");
  if (r.status === 202) return { sid, result: null };
  const text = await r.text();
  const body = r.headers.get("Content-Type")?.includes("text/event-stream")
    ? parseSSE(text)
    : JSON.parse(text || "{}");
  if (!r.ok) throw new Error(body?.error?.message || `MCP ${r.status}`);
  if (body.error) throw new Error(body.error.message);
  return { sid, result: body.result };
}

async function openSession(token) {
  const { sid } = await rpc(token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "slipclip", version: "1.0.0" }
    }
  });
  await rpc(token, sid, { jsonrpc: "2.0", method: "notifications/initialized" });
  return sid;
}

const textOf = (result) => (result?.content || []).map((c) => c.text).filter(Boolean).join(" ");

async function callTool(token, sid, name, args) {
  const { result } = await rpc(token, sid, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args }
  });
  if (result?.isError) throw new Error(errorText(textOf(result)) || "Notion rejected the request.");
  return result;
}

// ponytail: one MCP session per tool call. The popup is short-lived, so reusing
// a session across calls would only pay off in a long-lived page.
export async function mcpTool(name, args) {
  const auth = await ask("token");
  if (!auth?.ok) throw new Error(auth?.error || "Not connected.");
  const sid = await openSession(auth.token);
  return textOf(await callTool(auth.token, sid, name, args));
}
