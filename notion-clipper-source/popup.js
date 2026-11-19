import { normalizeId, parseResults, unwrapPayload, mcpTool, ask } from "./mcp.js";
import { pending, readHighlights, parseProperties, parseFetchKind } from "./highlights.js";
import { readDestination, tagsColumn, readClips, findClip } from "./clip.js";

const $ = (id) => document.getElementById(id);

// One place to write the status line, so its tone stays in sync with its text.
// A link, when there is one, is where the thing just said can be seen.
function say(text, tone = "", link = "") {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
  // With tags showing, the popup outgrows its 600px cap and the line can sit
  // just under the fold.
  if (text) $("status").scrollIntoView({ block: "nearest" });
  if (!link) return;
  const a = document.createElement("a");
  a.href = link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Open in Notion";
  $("status").append(" ", a);
}

// ---------- pure helpers (imported by test.mjs) ----------

// Inline databases only exist inside a page's content, so they never appear in
// recent pages or search. notion-fetch reports them as <database> tags.
export function parseChildDatabases(raw) {
  const text = unwrapPayload(raw);
  const seen = new Set();
  const out = [];
  // \s before url= on purpose: the tag also carries data-source-url=, which is
  // the data source, not the database.
  for (const [, url, label] of text.matchAll(/<database\b[^>]*?\surl="([^"]+)"[^>]*>([\s\S]*?)<\/database>/g)) {
    const id = normalizeId(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: label.trim(), type: "database" });
  }
  return out;
}

export function optionLabel({ title, type }) {
  const name = title.trim() || "Untitled";
  const short = name.length > 48 ? name.slice(0, 47).trimEnd() + "…" : name;
  return type === "page" ? short : `${short} (${type || "unknown"})`;
}

// Pinned destinations sit above whatever the list or a search shows.
export function togglePin(pinned, item) {
  return pinned.some((p) => p.id === item.id)
    ? pinned.filter((p) => p.id !== item.id)
    : [...pinned, item];
}

// ---------- destination picker ----------

function setOptions(labels) {
  const sel = $("picker");
  sel.replaceChildren();
  for (const [label, value, type] of labels) {
    const o = new Option(label, value);
    if (type) o.dataset.type = type;
    sel.append(o);
  }
}

let listed = [];
let pinned = [];

// Where clips go. It is kept here and in storage (parent, parentType,
// parentTitle), and the dropdown only displays it - so it survives a search
// that does not list it, and a popup that is closed and reopened.
let dest = { id: "", type: "", title: "" };

const itemFor = (id) => [...pinned, ...listed, dest].find((it) => it.id === id);

function renderPicker() {
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const rest = listed.filter((it) => !pinnedIds.has(it.id));
  // The chosen destination always has a row to sit in, even when the list that
  // loaded - recents, or a search for something else - leaves it out.
  const own = dest.id && !pinnedIds.has(dest.id) && !rest.some((it) => it.id === dest.id) ? [dest] : [];
  setOptions([
    [pinned.length || rest.length || own.length ? "Pick a destination" : "No results", ""],
    ...pinned.map((it) => ["★ " + optionLabel(it), it.id, it.type]),
    ...own.map((it) => [optionLabel(it), it.id, it.type]),
    ...rest.map((it) => [(it.inside ? "↳ " : "") + optionLabel(it), it.id, it.type])
  ]);
  $("picker").value = dest.id;
}

const NOTHING = "Nothing found. Clips reach only the pages you shared on Notion's consent screen.";

async function loadPicker(query) {
  setOptions([["Loading...", ""]]);
  try {
    const text = query
      ? await mcpTool("notion-search", { query, page_size: 25, max_highlight_length: 0 })
      : await mcpTool("notion-list-recent-pages", { limit: 25 });
    listed = parseResults(text);
    renderPicker();
    if (!listed.length) say(NOTHING);
    else if ($("status").textContent === NOTHING) say("");
  } catch (e) {
    // Pins are stored locally, so they stay usable when the list cannot load.
    listed = [];
    renderPicker();
    say("Error: " + e.message, "error");
  }
}

function paintPin() {
  const on = pinned.some((p) => p.id === dest.id);
  $("pin").setAttribute("aria-pressed", String(on));
  $("pin").textContent = on ? "★" : "☆";
  $("pin").title = on ? "Unpin this destination" : "Pin this destination";
}

async function pinCurrent() {
  if (!dest.id) return say("Pick a destination to pin first.");
  pinned = togglePin(pinned, { id: dest.id, title: dest.title, type: dest.type });
  await browser.storage.local.set({ pinned });
  renderPicker();
  paintPin();
}

// The dropdown's choice becomes the destination, and is remembered at once -
// a popup that closes before anything is clipped should still reopen on it.
function pick(item) {
  dest = { id: item.id, type: item.type || "", title: item.title || "" };
  browser.storage.local.set({ parent: dest.id, parentType: dest.type, parentTitle: dest.title });
  paintPin();
  showTags();
  if (dest.type === "page") expandPage(dest.id);
}

// A destination stored before titles and kinds were kept has neither, so the
// dropdown would call it "Untitled (unknown)". The lists usually know both;
// Notion is asked for whatever is left.
async function settleDest() {
  const id = dest.id;
  if (!id || (dest.title && dest.type)) return;
  const known = [...pinned, ...listed].find((it) => it.id === id);
  let title = dest.title || known?.title || "";
  let type = dest.type || known?.type || "";
  if (!title || !type) {
    try {
      const raw = await readDestination(id);
      if (!title) { try { title = JSON.parse(raw)?.title || ""; } catch { /* markup, not JSON */ } }
      if (!type) type = parseFetchKind(raw) || "";
    } catch { /* the label stays as it is */ }
  }
  if (dest.id !== id) return;
  dest = { id, title, type };
  await browser.storage.local.set({ parentTitle: title, parentType: type });
  renderPicker();
  showTags();
}

const isDatabaseType = (t) => t === "database" || t === "data_source";

// Tags are offered only where there is a tags column to put them in.
async function showTags() {
  $("tagbox").hidden = true;
  const { id, type } = dest;
  if (!id || !isDatabaseType(type)) return;
  try {
    const column = tagsColumn(parseProperties(await readDestination(id)));
    // The destination may have changed while Notion was answering.
    if (!column || dest.id !== id) return;
    $("taglab").textContent = column.name;
    $("tagopts").replaceChildren(...(column.options || []).map(({ name }) => {
      const chip = document.createElement("label");
      chip.className = "chip";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = name;
      const text = document.createElement("span");
      text.textContent = name;
      chip.append(box, text);
      return chip;
    }));
    $("newtags").value = "";
    $("tagbox").hidden = false;
  } catch (e) {
    console.debug("could not read the destination's columns:", e);
  }
}

const selectedTags = () => $("tagbox").hidden ? [] : [...new Set([
  ...[...$("tagopts").querySelectorAll("input:checked")].map((box) => box.value),
  ...$("newtags").value.split(",").map((t) => t.trim()).filter(Boolean)
])];

// Picking a page reveals the databases living inside it, indented beneath it.
async function expandPage(id, { silent = false } = {}) {
  if (listed.some((it) => it.inside === id)) return;
  if (!silent) say("Looking inside...");
  try {
    const raw = await mcpTool("notion-fetch", { id });
    const kids = parseChildDatabases(raw);
    if (!kids.length) {
      console.debug("notion-fetch returned no <database> tags:", raw);
      if (!silent) say("No databases inside that page.");
      return;
    }

    // The page may not be in the list at all - an auto-expanded destination
    // restored from storage, for instance. Children go last in that case.
    const at = listed.findIndex((it) => it.id === id);
    listed.splice(at === -1 ? listed.length : at + 1, 0, ...kids.map((k) => ({ ...k, inside: id })));
    renderPicker();

    // The select still shows the parent, so say where the new entries went,
    // without clobbering an existing error or "Already clipped" notice.
    if (!silent || !$("status").textContent) {
      say(`${kids.length} database${kids.length > 1 ? "s" : ""} inside. Open the list to pick one.`);
    }
  } catch (e) {
    if (!silent) say("Error: " + e.message, "error");
  }
}

// ---------- clipping ----------

const activeTab = async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0];

async function clip() {
  if (!dest.id) throw new Error("Pick a destination first.");

  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab to clip.");

  // Run in the background worker so closing the popup mid-request never aborts
  // the save. If the popup stays open, handle the result right here.
  const r = await browser.runtime.sendMessage({
    type: "clip",
    tabId: tab.id,
    options: {
      parentId: dest.id,
      known: dest.type,
      title: $("title").value,
      note: $("note").value,
      tags: selectedTags()
    }
  });
  if (!r?.ok) {
    await browser.storage.local.remove("clip_error");
    throw new Error(r?.error || "Clip failed.");
  }
  const { link, kind } = r;

  // A destination of unknown kind is settled now (the worker stored it), so the
  // tags can appear without reopening.
  if (kind && kind !== dest.type) {
    dest.type = kind;
    showTags();
  }
  return { link };
}

// ---------- UI ----------

// A right-click clips a highlight straight to Notion. One that could not be sent
// stays queued, and the badge keeps its count - so the popup tries again and says
// how it went, rather than leaving a number nobody can act on.
async function retryHighlights() {
  if (!pending(await readHighlights()).length) return;
  say("Sending highlights...");
  const r = await ask("flush-highlights").catch(() => null);
  if (r?.ok) say(r.sent ? `Sent ${r.sent} highlight${r.sent === 1 ? "" : "s"} to Notion.` : "");
  else say("Highlights not sent: " + (r?.error || "no answer from the extension."), "error");
}


async function paint() {
  const { access_token, auth_error } = await browser.storage.local.get(["access_token", "auth_error"]);
  const on = Boolean(access_token);
  $("state").textContent = on ? "Connected to Notion" : "Not connected";
  $("connect").textContent = on ? "Disconnect" : "Connect Notion";
  $("clip").disabled = !on;
  document.body.dataset.connected = String(on);
  if (auth_error) say("Sign-in failed: " + auth_error, "error");
}

if (typeof browser !== "undefined") {
  $("connect").addEventListener("click", async () => {
    say("");
    const { access_token } = await browser.storage.local.get("access_token");
    if (access_token) {
      await ask("signout");
      await paint();
      return;
    }
    // Firefox tears this popup down as soon as the Notion window takes focus,
    // so the reply below usually never arrives. The background page finishes
    // the flow either way; the user reopens the popup to see the result.
    say("Opening Notion... reopen this popup when done.");
    const r = await ask("signin").catch(() => null);
    if (r) {
      say(r.ok ? "" : "Sign-in failed: " + r.error, r.ok ? "" : "error");
      await paint();
    }
  });

  $("picker").addEventListener("change", (e) => {
    const item = e.target.value && itemFor(e.target.value);
    // The placeholder is not a destination; fall back to the one in force.
    if (item) pick(item);
    else renderPicker();
  });

  $("pin").addEventListener("click", () => {
    pinCurrent().catch((e) => say("Error: " + e.message, "error"));
  });

  let searchTimer;
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPicker($("q").value.trim()), 350);
  });

  $("clip").addEventListener("click", async () => {
    $("clip").disabled = true;
    say("Clipping...");
    try {
      const { link } = await clip();
      say("Clipped.", "", link);
      $("clip").textContent = "Clip again";
    } catch (e) {
      say("Error: " + e.message, "error");
    } finally {
      $("clip").disabled = false;
    }
  });

  $("openoptions").addEventListener("click", () => browser.runtime.openOptionsPage());

  (async () => {
    const s = await browser.storage.local.get(["parent", "parentType", "parentTitle", "pinned", "clip_error"]);
    pinned = Array.isArray(s.pinned) ? s.pinned : [];
    // `parent` was once whatever was typed in the link box, so it may still be a URL.
    const id = normalizeId(s.parent);
    if (id) dest = { id, type: s.parentType || "", title: s.parentTitle || "" };
    // Signed out with nothing remembered, the markup's own prompt stays.
    if (dest.id || pinned.length) renderPicker();
    paintPin();
    await paint();

    // Seen before: say so, and where it went, before anyone clips it twice.
    const tab = await activeTab().catch(() => null);
    const seen = tab?.url && findClip(await readClips(), tab.url);
    if (seen) {
      $("clip").textContent = "Clip again";
      say(`Already clipped on ${new Date(seen.at).toLocaleDateString()}.`, "", seen.link);
    }

    // The shortcut and the context menu have no surface of their own, so a
    // failure there is reported here, once.
    if (s.clip_error) {
      say("Last quick clip failed: " + s.clip_error, "error");
      await browser.storage.local.remove("clip_error");
    }

    const { access_token } = await browser.storage.local.get("access_token");
    if (!access_token) return;

    // Not awaited: the destination list should not wait on it.
    retryHighlights().catch((e) => say("Highlights: " + e.message, "error"));

    showTags();
    await loadPicker("");
    await settleDest();

    // Reopening on a remembered page: surface its inline databases without
    // making the user re-pick the page first.
    if (dest.id && !isDatabaseType(dest.type)) expandPage(dest.id, { silent: true });
  })();
}
