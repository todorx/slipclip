import { extractPage } from "./extract.js";

import { normalizeId, parseResults, unwrapPayload, mcpTool, ask } from "./mcp.js";
import { groupBySource, pending, coalesce, flushPending, readHighlights, writeHighlights, applyMapping, highlightsMarkdown, quoteLines } from "./highlights.js";

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

// ---------- highlights ----------

function renderHighlights(list) {
  const box = $("hlist");
  box.replaceChildren();
  if (!list.length) {
    box.textContent = "No highlights yet. Select some text and press Alt+Shift+H.";
    return;
  }

  // The list is newest-first and groupBySource keeps insertion order, so the
  // source you just saved into is always the first group and each group reads
  // newest-first too.
  for (const [canonical, items] of groupBySource(list)) {
    const head = document.createElement("div");
    head.className = "hgroup";
    head.textContent = items[0].title || items[0].site || canonical;
    box.append(head);

    for (const h of items) {
      const row = document.createElement("div");
      row.className = "hitem";

      const quote = document.createElement("q");
      quote.textContent = h.truncated ? h.text + "…" : h.text;

      const source = document.createElement("cite");
      source.textContent = h.synced ? "synced" : "waiting";

      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        await writeHighlights((await readHighlights()).filter((x) => x.key !== h.key));
        // Deleting changes the pending count, so the sync button and the badge
        // both have to follow it - not just the list.
        await refreshHighlights();
        await repaintBadge();
      });

      row.append(quote, source, del);
      box.append(row);
    }
  }
}

// The badge is the background worker's, so it has to be asked to repaint;
// without this it keeps showing the count from before the popup drained.
const repaintBadge = () => browser.runtime.sendMessage({ type: "repaint-badge" }).catch(() => {});

// Set by a failed flush so the sync control offers Retry rather than pretending
// nothing happened.
let flushFailed = false;

async function refreshHighlights() {
  const list = await readHighlights();
  renderHighlights(list);
  const waiting = pending(list).length;
  // The collapsed summary is one line, so the count is the only thing on it
  // worth reading. Nothing waiting means no control at all rather than a dead
  // disabled button.
  $("hcount").textContent = waiting ? `${waiting} waiting` : "";
  $("sync").hidden = !waiting;
  $("sync").disabled = false;
  $("sync").textContent = flushFailed ? `Retry ${waiting}` : `Sync ${waiting} to Notion`;
}

// A destination is only needed once something is actually queued, so an
// extension nobody has set up for highlights does not open with an error.
async function flushHighlights() {
  if (!pending(await readHighlights()).length) return 0;

  const { destinations } = await browser.storage.local.get("destinations");
  const dest = destinations?.highlights;
  // A config stored before pages were allowed carries no kind, and could only
  // ever have been a database.
  const kind = dest?.kind ?? "database";

  // The storage choreography lives in highlights.js either way - flushPending
  // takes the writer, so only the call inside it changes.
  if (kind === "page") {
    if (!dest?.pageId) throw new Error("No highlights destination set. Open Settings.");
    return flushPending((batch) => mcpTool("notion-update-page", {
      page_id: dest.pageId,
      command: "insert_content",
      content: highlightsMarkdown(batch),
      position: { type: "end" },
      // allow_async defaults true, which answers with a task rather than a
      // result - and the batch is only stamped once this returns.
      allow_async: false
    }));
  }

  if (!dest?.dataSourceId) throw new Error("No highlights destination set. Open Settings.");
  if (!dest.mapping?.text?.name) throw new Error("No passage column mapped. Open Settings.");
  return flushPending((batch) => mcpTool("notion-create-pages", {
    parent: { data_source_id: dest.dataSourceId },
    pages: batch.map((h) => ({ properties: applyMapping(h, dest.mapping) }))
  }));
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

  $("openoptions").addEventListener("click", () => browser.runtime.openOptionsPage());

  (async () => {
    const s = await browser.storage.local.get(["parent", "parentType"]);
    if (s.parent) $("parent").value = s.parent;
    if (s.parentType) $("parent").dataset.type = s.parentType;
    syncMode();
    await paint();

    const { access_token } = await browser.storage.local.get("access_token");

    // Coalesced: a second press while a flush is in flight joins it instead of
    // writing the same queue to Notion twice.
    const syncNow = coalesce(flushHighlights);

    // The popup is the app's only surface, so the queue drains here - whichever
    // tab you happened to land on. A failure leaves it queued for a retry.
    const flushNow = async () => {
      // The spec asks the tab to report progress; the control is the only place
      // to put it, since the status line belongs to whichever tab you are on.
      if (pending(await readHighlights()).length) {
        $("sync").disabled = true;
        $("sync").textContent = "Syncing...";
      }
      try {
        const n = await syncNow();
        flushFailed = false;
        if (n) say(`Synced ${n} highlight${n === 1 ? "" : "s"}.`);
      } catch (e) {
        flushFailed = true;
        // Whatever went wrong is about the queue, so show the queue.
        $("highlights").open = true;
        say("Highlights: " + e.message, "error");
      }
      await refreshHighlights();
      await repaintBadge();
    };

    $("sync").addEventListener("click", () => {
      say("Syncing...");
      return flushNow();
    });

    if (access_token) await flushNow();
    else await refreshHighlights();

    if (!access_token) return;
    await loadPicker("");

    // Reopening on a remembered page: surface its inline databases without
    // making the user re-pick the page first.
    const remembered = normalizeId($("parent").value);
    if (remembered && $("parent").dataset.type !== "database") expandPage(remembered);
  })();
}
