import { normalizeId, parseResults, unwrapPayload, mcpTool, ask } from "./mcp.js";
import { groupBySource, pending, coalesce, flushPending, readHighlights, writeHighlights, applyMapping, highlightsMarkdown, parseProperties } from "./highlights.js";
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

function renderPicker(selectedId) {
  const pinnedIds = new Set(pinned.map((p) => p.id));
  setOptions([
    [listed.length || pinned.length ? "Pick a destination" : "No results", ""],
    ...pinned.map((it) => ["★ " + optionLabel(it), it.id, it.type]),
    ...listed.filter((it) => !pinnedIds.has(it.id)).map((it) => [(it.inside ? "↳ " : "") + optionLabel(it), it.id, it.type])
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
    // Pins are stored locally, so they stay usable when the list cannot load.
    listed = [];
    renderPicker();
    say("Error: " + e.message, "error");
  }
}

const currentId = () => normalizeId($("parent").value);

function paintPin() {
  const on = pinned.some((p) => p.id === currentId());
  $("pin").setAttribute("aria-pressed", String(on));
  $("pin").textContent = on ? "★" : "☆";
  $("pin").title = on ? "Unpin this destination" : "Pin this destination";
}

async function pinCurrent() {
  const id = currentId();
  if (!id) return say("Pick a destination to pin first.");
  const known = [...pinned, ...listed].find((it) => it.id === id);
  // A pasted link has no title until Notion is asked for one.
  let title = known?.title;
  if (!title && !pinned.some((p) => p.id === id)) {
    try { title = JSON.parse(await readDestination(id))?.title; } catch { /* the label falls back to Untitled */ }
  }
  pinned = togglePin(pinned, { id, title: title || "", type: $("parent").dataset.type || known?.type || "" });
  await browser.storage.local.set({ pinned });
  renderPicker(id);
  paintPin();
}

const isDatabaseType = (t) => t === "database" || t === "data_source";

// Tags are offered only where there is a tags column to put them in.
async function showTags() {
  $("tagbox").hidden = true;
  const id = currentId();
  if (!id || !isDatabaseType($("parent").dataset.type)) return;
  try {
    const column = tagsColumn(parseProperties(await readDestination(id)));
    // The destination may have changed while Notion was answering.
    if (!column || currentId() !== id) return;
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
    renderPicker(id);

    // The select still shows the parent, so say where the new entries went,
    // without clobbering an existing error or "Already clipped" notice.
    if (!silent || !$("status").textContent) {
      say(`${kids.length} database${kids.length > 1 ? "s" : ""} inside. Open Destination to pick one.`);
    }
  } catch (e) {
    if (!silent) say("Error: " + e.message, "error");
  }
}

// ---------- clipping ----------

const activeTab = async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0];

async function clip() {
  const parentId = currentId();
  if (!parentId) throw new Error("Pick a destination, or paste a Notion link.");
  const known = $("parent").dataset.type || "";
  await browser.storage.local.set({ parent: $("parent").value, parentType: known });

  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab to clip.");
  const mode = $("mode").disabled ? "child" : $("mode").value;

  // Run in the background worker so closing the popup mid-request never aborts
  // the save. If the popup stays open, handle the result right here.
  const r = await browser.runtime.sendMessage({
    type: "clip",
    tabId: tab.id,
    options: {
      parentId,
      known,
      mode,
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

  // A pasted link is settled now, so the next open knows what it points at.
  if (kind && kind !== known) {
    $("parent").dataset.type = kind;
    syncMode();
    showTags();
  }
  return { link, mode };
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
  const isDatabase = isDatabaseType($("parent").dataset.type);
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
    paintPin();
    showTags();
    if (opt.dataset.type === "page") expandPage(opt.value);
  });

  // Typed by hand means the kind is unknown again - clip() will work it out.
  $("parent").addEventListener("input", () => {
    $("parent").dataset.type = "";
    syncMode();
    paintPin();
    $("tagbox").hidden = true;
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
      const { link, mode } = await clip();
      say(mode === "append" ? "Added to the end of the page." : "Clipped.", "", link);
      $("clip").textContent = "Clip again";
    } catch (e) {
      say("Error: " + e.message, "error");
    } finally {
      $("clip").disabled = false;
    }
  });

  $("openoptions").addEventListener("click", () => browser.runtime.openOptionsPage());

  (async () => {
    const s = await browser.storage.local.get(["parent", "parentType", "pinned", "clip_error"]);
    if (s.parent) $("parent").value = s.parent;
    if (s.parentType) $("parent").dataset.type = s.parentType;
    pinned = Array.isArray(s.pinned) ? s.pinned : [];
    syncMode();
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
    showTags();
    await loadPicker("");

    // Reopening on a remembered page: surface its inline databases without
    // making the user re-pick the page first.
    const remembered = normalizeId($("parent").value);
    if (remembered && !isDatabaseType($("parent").dataset.type)) expandPage(remembered, { silent: true });
  })();
}
