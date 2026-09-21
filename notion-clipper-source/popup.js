import { extractPage } from "./extract.js";

import { normalizeId, parseResults, unwrapPayload, mcpTool, ask } from "./mcp.js";

const $ = (id) => document.getElementById(id);

// One place to write the status line, so its tone stays in sync with its text.
function say(text, tone = "") {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
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

// ISO 8601 duration to clock time, for the facts line.
export function formatDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || "");
  if (!m) return "";
  const [, d, h, min, s] = m.map((v) => Number(v) || 0);
  const total = ((d * 24 + h) * 60 + min) * 60 + s;
  if (!total) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
    : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

// Every line prefixed, blanks included, so a multi-line quote stays one
// blockquote in Notion instead of splitting into a stack of them.
const quoteLines = (text) =>
  text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");

// `heading` turns the source line into an H2 - appended clips need a visible
// break between them, a new page does not.
export function buildMarkdown(page, { heading = false } = {}) {
  const { url, title, description, selection, siteName, author, published, duration, body, truncated, kind } = page;
  const link = title ? `[${title.replace(/[[\]]/g, "\\$&")}](${url})` : url;
  const facts = [siteName, author, published, formatDuration(duration)].filter(Boolean).join(" · ");

  // The passage you chose, or an index's blurb plus its links, or the article,
  // or - when there is no body at all - the summary.
  let meat;
  if (selection) meat = quoteLines(selection);
  else if (kind === "index") meat = [description, body].filter(Boolean).join("\n\n");
  else meat = body || description;

  return [
    heading ? `## ${link}` : link,
    facts && `*${facts}*`,
    meat,
    truncated && !selection && "*Article truncated.*"
  ].filter(Boolean).join("\n\n");
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

function renderPicker(selectedId) {
  setOptions([
    [listed.length ? "Pick a destination" : "No results", ""],
    ...listed.map((it) => [(it.inside ? "↳ " : "") + optionLabel(it), it.id, it.type])
  ]);
  if (selectedId) $("picker").value = selectedId;
}

async function loadPicker(query) {
  setOptions([["Loading...", ""]]);
  try {
    const text = query
      ? await mcpTool("notion-search", { query, page_size: 25, max_highlight_length: 0 })
      : await mcpTool("notion-list-recent-pages", { limit: 25 });
    listed = parseResults(text);
    renderPicker();
  } catch (e) {
    listed = [];
    setOptions([["Could not load pages", ""]]);
    say("Error: " + e.message, "error");
  }
}

// Picking a page reveals the databases living inside it, indented beneath it.
async function expandPage(id) {
  if (listed.some((it) => it.inside === id)) return;
  say("Looking inside...");
  try {
    const raw = await mcpTool("notion-fetch", { id });
    const kids = parseChildDatabases(raw);
    if (!kids.length) {
      console.debug("notion-fetch returned no <database> tags:", raw);
      return say("No databases inside that page.");
    }

    // The page may not be in the list at all - an auto-expanded destination
    // restored from storage, for instance. Children go last in that case.
    const at = listed.findIndex((it) => it.id === id);
    listed.splice(at === -1 ? listed.length : at + 1, 0, ...kids.map((k) => ({ ...k, inside: id })));
    renderPicker(id);

    // The select still shows the parent, so say where the new entries went.
    say(`${kids.length} database${kids.length > 1 ? "s" : ""} inside. Open Destination to pick one.`);
  } catch (e) {
    say("Error: " + e.message, "error");
  }
}

// ---------- clipping ----------

async function getTabData() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab to clip.");
  const target = { tabId: tab.id };

  // Firefox refuses injection on about:*, view-source: and addons.mozilla.org,
  // and answers with an empty array rather than an error.
  let injected = [];
  try {
    // Same isolated world both times, so extractPage sees these as globals.
    await browser.scripting.executeScript({ target, files: ["vendor/Readability.js", "vendor/turndown.js", "vendor/turndown-plugin-gfm.js"] });
    injected = await browser.scripting.executeScript({ target, func: extractPage });
  } catch { injected = []; }

  const data = injected?.[0]?.result;
  if (!data) throw new Error("Can't read this page. Browsers block extensions on browser pages such as about:debugging or chrome://extensions - switch to a normal web page and clip that.");
  return data;
}

const createPage = (parentId, kind, pages) =>
  mcpTool("notion-create-pages", {
    parent: kind === "database" ? { database_id: parentId } : { page_id: parentId },
    pages
  });

async function clip() {
  const parentId = normalizeId($("parent").value);
  if (!parentId) throw new Error("Pick a destination, or paste a Notion link.");
  const known = $("parent").dataset.type;
  const mode = $("mode").disabled ? "child" : $("mode").value;
  await browser.storage.local.set({ parent: $("parent").value, parentType: known || "" });

  const tab = await getTabData();
  const title = ($("title").value.trim() || tab.title || "Untitled clip").slice(0, 100);

  if (mode === "append") {
    // allow_async defaults true here, which would answer with a task instead of
    // a result. A clip is small enough to just wait for.
    const text = await mcpTool("notion-update-page", {
      page_id: parentId,
      command: "insert_content",
      content: buildMarkdown({ ...tab, title }, { heading: true }),
      position: { type: "end" },
      allow_async: false
    });
    return text || "Appended to the page.";
  }

  const pages = [{ properties: { title }, content: buildMarkdown({ ...tab, title }) }];

  try {
    return await createPage(parentId, known || "page", pages) || "Clipped to Notion.";
  } catch (e) {
    // A pasted link doesn't say which kind it is. Notion's error does, so one
    // retry beats making the user classify it.
    if (known || !/not a (page|database)/i.test(e.message)) throw e;
    return await createPage(parentId, "database", pages) || "Clipped to Notion.";
  }
}

// ---------- UI ----------

// You cannot append blocks to a database, so that choice disappears when the
// destination is known to be one.
function syncMode() {
  const isDatabase = $("parent").dataset.type === "database";
  $("mode").disabled = isDatabase;
  if (isDatabase) $("mode").value = "child";
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
    const opt = e.target.selectedOptions[0];
    if (!opt?.value) return;
    $("parent").value = opt.value;
    $("parent").dataset.type = opt.dataset.type || "";
    syncMode();
    if (opt.dataset.type === "page") expandPage(opt.value);
  });

  // Typed by hand means the kind is unknown again - clip() will work it out.
  $("parent").addEventListener("input", () => {
    $("parent").dataset.type = "";
    syncMode();
  });

  let searchTimer;
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPicker($("q").value.trim()), 350);
  });

  $("clip").addEventListener("click", async () => {
    say("Clipping...");
    try { say("Done: " + await clip()); }
    catch (e) { say("Error: " + e.message, "error"); }
  });

  (async () => {
    const s = await browser.storage.local.get(["parent", "parentType"]);
    if (s.parent) $("parent").value = s.parent;
    if (s.parentType) $("parent").dataset.type = s.parentType;
    syncMode();
    await paint();
    const { access_token } = await browser.storage.local.get("access_token");
    if (!access_token) return;
    await loadPicker("");

    // Reopening on a remembered page: surface its inline databases without
    // making the user re-pick the page first.
    const remembered = normalizeId($("parent").value);
    if (remembered && $("parent").dataset.type !== "database") expandPage(remembered);
  })();
}
