# SlipClip Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture text selections from any page into local storage, then flush them into a user-configured Notion database.

**Architecture:** Capture lives in the background worker (the popup is destroyed when focus moves, so it cannot own capture — same reason sign-in lives there). `storage.local` is the source of truth until a flush succeeds; the popup is the library and the flush trigger. All Notion-shaped logic sits behind pure functions in `highlights.js` so it is testable without a browser or a network.

**Tech Stack:** Vanilla JS, MV3, no deps, no build step. Node 18+ for `test.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-21-highlights-design.md`

## Global Constraints

- No build step, no package.json, no dependencies.
- `cd notion-clipper-source && node test.mjs` must print `ok` after every task.
- Keep `auth.js`, `popup.js`, `mcp.js` and `highlights.js` free of top-level `document`/`browser` access — `test.mjs` imports them under plain Node.
- `extractPage()` must not reference anything outside itself (`scripting.executeScript` serialises its source).
- `vendor/` release builds are never edited.
- Save-as mode resets to "new page" on every popup open — never sticky. Untouched by this plan.
- Never write to `storage.local` from two places at once; capture serialises through a promise chain.

## Review Focus

- Browser restarts or the worker is suspended between capture and flush → expect the highlight to still be there and still unsynced; capture must never hold a highlight only in memory.
- The same passage highlighted twice, including from two URLs of one article (`?utm_source=…`, a `#fragment`) → expect one stored highlight, badge unchanged, never two rows in Notion.
- A shortcut press with nothing selected → expect the badge to say so, never a stored empty highlight.
- A destination database whose columns were renamed or deleted after setup → expect the flush to fail loudly naming the column with the queue intact, never a partial or silent write.
- A passage over 2000 characters → expect it capped and marked, never a rejected write.

---

### Task 1: Extract the shared MCP client

**Files:**
- Create: `notion-clipper-source/mcp.js`
- Modify: `notion-clipper-source/popup.js`
- Modify: `notion-clipper-source/test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `mcp.js` exporting `MCP`, `PROTOCOL_VERSION`, `ask(type)`, `normalizeId(input) → string|null`, `parseResults(text) → {id,title,type}[]`, `errorText(raw) → string`, `unwrapPayload(raw) → string`, `mcpTool(name, args) → Promise<string>`.

- [ ] **Step 1: Create `mcp.js`**

Move these out of `popup.js` unchanged in behaviour: the `browser`/`chrome` shim, `MCP`, `PROTOCOL_VERSION`, `ask`, `normalizeId`, `parseResults`, `errorText`, `parseSSE`, `rpc`, `openSession`, `textOf`, `callTool`, `mcpTool`. Add `unwrapPayload` (the JSON-unwrap currently inlined at the top of `parseChildDatabases`).

```js
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
```

Then `parseSSE`, `rpc`, `openSession`, `textOf`, `callTool`, `mcpTool` verbatim from `popup.js` lines 117–177, with `mcpTool` exported.

- [ ] **Step 2: Point `popup.js` at it**

Delete the moved code from `popup.js` (lines 3–42 and 113–177) and import instead. `parseChildDatabases` keeps its own body but uses the shared unwrap:

```js
import { normalizeId, parseResults, errorText, unwrapPayload, mcpTool, ask } from "./mcp.js";

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
```

- [ ] **Step 3: Update the `test.mjs` import**

```js
import { normalizeId, parseResults, errorText, unwrapPayload } from "./mcp.js";
import { buildMarkdown, optionLabel, parseChildDatabases, formatDuration } from "./popup.js";
```

Add one assertion proving `unwrapPayload` covers the shapes `parseChildDatabases` used to handle itself:

```js
assert.equal(unwrapPayload(JSON.stringify({ text: "<p>x</p>" })), "<p>x</p>", "JSON-wrapped markup unwraps");
assert.equal(unwrapPayload("<p>x</p>"), "<p>x</p>", "bare markup passes through");
```

- [ ] **Step 4: Run the suite**

Run: `cd notion-clipper-source && node test.mjs`
Expected: `ok`. This is a pure move — every existing assertion must still pass.

- [ ] **Step 5: Commit**

```bash
git add notion-clipper-source/mcp.js notion-clipper-source/popup.js notion-clipper-source/test.mjs
git commit -m "refactor: extract the shared MCP transport into mcp.js"
```

---

### Task 2: The pure highlights core

**Files:**
- Create: `notion-clipper-source/highlights.js`
- Modify: `notion-clipper-source/test.mjs`

**Interfaces:**
- Consumes: `normalizeId`, `unwrapPayload` from `mcp.js`.
- Produces:
  - `canonicalUrl(url) → string`
  - `dedupeKey(url, text) → string`
  - `addHighlight(list, record) → { list, added }` — `record` is `{text, note, url, title, site, author, published, created}`
  - `pending(list) → highlight[]`
  - `groupBySource(list) → Map<string, highlight[]>`
  - `applyMapping(highlight, mapping) → object`
  - `parseDataSourceId(raw) → string|null`
  - `parseProperties(raw) → {name, type}[]`
  - `matchProperties(properties) → mapping`
  - `readHighlights() / writeHighlights(list)` — async storage wrappers
  - `TEXT_LIMIT = 2000`

- [ ] **Step 1: Write the failing tests**

Append to `test.mjs`:

```js
// --- highlights ---

// Tracking parameters and fragments differ per share link for one article.
assert.equal(
  canonicalUrl("https://www.Example.com/Post/?utm_source=x&utm_medium=y#top"),
  canonicalUrl("https://example.com/Post"),
  "fragments, www and tracking params are not part of a page's identity"
);
assert.equal(
  canonicalUrl("https://example.com/a?page=2"),
  "https://example.com/a?page=2",
  "a meaningful query parameter survives"
);
assert.equal(canonicalUrl("not a url"), "not a url", "unparseable input is passed through");

// A passage saved twice is one highlight; the same passage in two articles is two.
const articleA = "https://example.com/a";
const articleB = "https://example.com/b";
let store = [];
({ list: store } = addHighlight(store, { text: "One sentence.", url: articleA, title: "A" }));
({ list: store } = addHighlight(store, { text: "One sentence.", url: articleA + "?utm_source=t", title: "A" }));
assert.equal(store.length, 1, "the same passage from a tracking-parameter URL is a duplicate");

({ list: store } = addHighlight(store, { text: "Another sentence.", url: articleA, title: "A" }));
assert.equal(store.length, 2, "a different passage from the same page is not");

({ list: store } = addHighlight(store, { text: "One sentence.", url: articleB, title: "B" }));
assert.equal(store.length, 3, "the same passage from another page is not");

const dupe = addHighlight(store, { text: "One sentence.", url: articleA, title: "A" });
assert.equal(dupe.added, false, "a duplicate reports itself");
assert.equal(dupe.list.length, 3, "and does not grow the store");

// Notion rejects a rich-text value over 2000 characters.
const long = addHighlight([], { text: "x".repeat(2500), url: articleA, title: "A" }).list[0];
assert.equal(long.text.length, 2000, "text is capped at the API limit");
assert.equal(long.truncated, true, "and says so");
assert.equal(addHighlight([], { text: "short", url: articleA, title: "A" }).list[0].truncated, false);

assert.equal(pending(store).length, 3, "everything starts unsynced");
assert.equal(pending([{ synced: 1 }, { synced: null }]).length, 1, "synced highlights are done");

const grouped = groupBySource([
  { canonical: articleA, key: "1" }, { canonical: articleB, key: "2" }, { canonical: articleA, key: "3" }
]);
assert.equal(grouped.size, 2, "one group per source");
assert.equal(grouped.get(articleA).length, 2);

// A property called URL collides with a reserved name and must be prefixed.
const mapping = {
  text: { name: "Highlight", type: "title" },
  url: { name: "URL", type: "url" },
  created: { name: "Highlighted", type: "date" },
  title: { name: "Source", type: "rich_text" },
  note: { name: "Note", type: "rich_text" }
};
const props = applyMapping(
  { text: "A passage.", url: "https://example.com/a", title: "An Article", note: "", created: Date.UTC(2026, 8, 21) },
  mapping
);
assert.equal(props["userDefined:URL"], "https://example.com/a", "a url-named property is prefixed");
assert.equal(props.Highlight, "A passage.", "the title property name is whatever the mapping says");
assert.equal(props.Source, "An Article");
assert.ok(!("Note" in props), "an empty note is omitted, not written as an empty string");
assert.equal(props["date:Highlighted:start"], "2026-09-21", "the date is split into start");
assert.equal(props["date:Highlighted:is_datetime"], 0, "and declares itself a date, not a datetime");

assert.deepEqual(
  applyMapping({ text: "x", url: "u", created: Date.UTC(2026, 8, 21) }, { url: { name: "Link", type: "url" } }),
  { Link: "u" },
  "unmapped fields are omitted entirely"
);

// The schema and the data source id come back as markup from notion-fetch.
const dbPayload = JSON.stringify({
  text: '<database url="https://app.notion.com/p/33333333-3333-4333-8333-333333333333">\n'
    + '<data-source url="collection://55555555-5555-4555-8555-555555555555">\n'
    + 'CREATE TABLE (\n'
    + '  "Highlight" TITLE,\n'
    + '  "Source" RICH_TEXT,\n'
    + '  "Author" RICH_TEXT,\n'
    + '  "Site" RICH_TEXT,\n'
    + '  "URL" URL,\n'
    + '  "Highlighted" DATE,\n'
    + '  "Note" RICH_TEXT\n'
    + ')'
});
assert.equal(parseDataSourceId(dbPayload), "55555555-5555-4555-8555-555555555555", "the collection id, not the page id");
assert.equal(parseDataSourceId("no collection here"), null);

const schema = parseProperties(dbPayload);
assert.equal(schema.length, 7, "every column is read");
assert.deepEqual(schema[0], { name: "Highlight", type: "TITLE" });
assert.ok(schema.some((p) => p.name === "URL" && p.type === "URL"));

const matched = matchProperties(schema);
assert.equal(matched.text.name, "Highlight", "the title property takes the passage");
assert.equal(matched.url.name, "URL", "the url-typed property takes the link");
assert.equal(matched.created.name, "Highlighted", "the date-typed property takes the date");
assert.equal(matched.title.name, "Source", "Source is not confused with the title property");
assert.equal(matched.author.name, "Author");
assert.equal(matched.site.name, "Site");
assert.equal(matched.note.name, "Note");

// A stock database whose title property is just "Name" still maps.
const plain = matchProperties(parseProperties(JSON.stringify({ text: 'CREATE TABLE ("Name" TITLE)' })));
assert.equal(plain.text.name, "Name", "an unrecognised title property is still the passage target");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd notion-clipper-source && node test.mjs`
Expected: FAIL — `canonicalUrl is not defined`.

- [ ] **Step 3: Implement `highlights.js`**

```js
// Highlights are captured by background.js, held in storage.local until the
// popup flushes them, then written to a Notion database. Everything that shapes
// a Notion write is pure and covered by test.mjs.

import { normalizeId, unwrapPayload } from "./mcp.js";

// Notion caps a rich-text value at 2000 characters.
export const TEXT_LIMIT = 2000;
export const HIGHLIGHTS_KEY = "highlights";

// Share links vary in the parameters and fragments that decorate the same page.
// ponytail: a fixed list, not a registry - add a parameter when a real link
// fails to dedupe against its twin.
const TRACKING = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|si$|ref_src$|_hsenc$|_hsmi$|yclid$|twclid$)/i;

// The identity of "the same page". The record keeps the raw url for linking;
// this is only ever used to compare.
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return String(raw ?? ""); }
  if (!/^https?:$/.test(u.protocol)) return String(raw ?? "");
  u.hash = "";
  u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href;
}

// A passage is identified by where it came from and what it says.
export function dedupeKey(url, text) {
  return `${canonicalUrl(url)}\u0000${String(text ?? "").replace(/\s+/g, " ").trim()}`;
}

// Newest first. A duplicate is rejected rather than replaced, so re-highlighting
// something never resets its synced state or its position.
export function addHighlight(list, record) {
  const text = String(record.text ?? "").replace(/\s+/g, " ").trim();
  const key = dedupeKey(record.url, text);
  if (list.some((h) => h.key === key)) return { list, added: false };
  return {
    list: [{
      ...record,
      text: text.slice(0, TEXT_LIMIT),
      truncated: text.length > TEXT_LIMIT,
      key,
      canonical: canonicalUrl(record.url),
      note: record.note ?? "",
      created: record.created || Date.now(),
      synced: null
    }, ...list],
    added: true
  };
}

export const pending = (list) => list.filter((h) => !h.synced);

export function groupBySource(list) {
  const groups = new Map();
  for (const h of list) groups.set(h.canonical, [...(groups.get(h.canonical) || []), h]);
  return groups;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// Notion property names have two sharp edges: "id" and "url" collide with
// reserved names case-insensitively, and a date is three fields, not one.
export function applyMapping(highlight, mapping) {
  const nameOf = (field) => {
    const name = mapping?.[field]?.name;
    if (!name) return null;
    return /^(id|url)$/i.test(name) ? `userDefined:${name}` : name;
  };

  const props = {};
  const simple = {
    text: highlight.text,
    url: highlight.url,
    title: highlight.title,
    author: highlight.author,
    site: highlight.site,
    note: highlight.note
  };
  for (const [field, value] of Object.entries(simple)) {
    const name = nameOf(field);
    if (!name || !value) continue;
    props[name] = String(value).slice(0, TEXT_LIMIT);
  }

  const dateName = nameOf("created");
  if (dateName && highlight.created) {
    props[`date:${dateName}:start`] = day(highlight.created);
    props[`date:${dateName}:is_datetime`] = 0;
  }
  return props;
}

const COLUMN = /^\s*"([^"]+)"\s+(TITLE|RICH_TEXT|DATE|URL|EMAIL|PHONE_NUMBER|STATUS|FILES|PEOPLE|CHECKBOX|NUMBER|SELECT|MULTI_SELECT|UNIQUE_ID|CREATED_TIME|LAST_EDITED_TIME|FORMULA|RELATION|ROLLUP)\b/;

// notion-fetch reports a database's columns as a CREATE TABLE block. Columns
// carry quoted names; anything else on the line is ignored.
export function parseProperties(raw) {
  const out = [];
  for (const line of unwrapPayload(raw).split("\n")) {
    const m = COLUMN.exec(line);
    if (!m || out.some((p) => p.name === m[1])) continue;
    out.push({ name: m[1], type: m[2] });
  }
  return out;
}

export function parseDataSourceId(raw) {
  const m = /collection:\/\/([0-9a-f-]{36})/i.exec(unwrapPayload(raw));
  return m ? normalizeId(m[1]) : null;
}

// Ordered, and each field takes the first unused property that fits it, so the
// title column cannot be stolen by the Source field.
const FIELD_RULES = [
  ["text",    (p) => p.type === "TITLE",     /highlight|quote|passage|text/i],
  ["url",     (p) => p.type === "URL",       /url|link/i],
  ["created", (p) => p.type === "DATE",      /highlight|saved|created|date/i],
  ["title",   (p) => p.type === "RICH_TEXT", /source|article|book|page|title/i],
  ["author",  (p) => p.type === "RICH_TEXT", /author|byline|writer|creator/i],
  ["site",    (p) => p.type === "RICH_TEXT", /site|publication|domain|publisher/i],
  ["note",    (p) => p.type === "RICH_TEXT", /note|comment|thought/i]
];

export function matchProperties(properties) {
  const mapping = {};
  const taken = new Set();
  for (const [field, byType, byName] of FIELD_RULES) {
    const pool = properties.filter((p) => !taken.has(p.name) && byType(p));
    const pick = pool.find((p) => byName.test(p.name)) || pool[0];
    if (!pick) continue;
    taken.add(pick.name);
    mapping[field] = { name: pick.name, type: pick.type };
  }
  return mapping;
}

export async function readHighlights() {
  const { highlights } = await browser.storage.local.get(HIGHLIGHTS_KEY);
  return Array.isArray(highlights) ? highlights : [];
}

export async function writeHighlights(list) {
  await browser.storage.local.set({ [HIGHLIGHTS_KEY]: list });
  return list;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd notion-clipper-source && node test.mjs`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add notion-clipper-source/highlights.js notion-clipper-source/test.mjs
git commit -m "feat(highlights): pure store, dedupe, and Notion mapping"
```

---

### Task 3: Capture in the background worker

**Files:**
- Modify: `notion-clipper-source/background.js`
- Modify: `notion-clipper-source/manifest.json`

**Interfaces:**
- Consumes: `addHighlight`, `readHighlights`, `writeHighlights`, `pending` from `highlights.js`.
- Produces: stored `highlights` array; `contextMenus` item `slipclip-highlight`; command `save-highlight`.

- [ ] **Step 1: Add the permissions, command and options page to `manifest.json`**

```json
  "permissions": [
    "activeTab",
    "storage",
    "scripting",
    "identity",
    "declarativeNetRequest",
    "contextMenus"
  ],
  "commands": {
    "save-highlight": {
      "suggested_key": { "default": "Alt+Shift+H" },
      "description": "Save the selected text as a highlight"
    }
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
```

- [ ] **Step 2: Add capture to `background.js`**

```js
import { addHighlight, pending, readHighlights, writeHighlights } from "./highlights.js";

const MENU_ID = "slipclip-highlight";

// A menu survives a worker restart, but a reload during development would
// duplicate it, so start from empty every install.
browser.runtime.onInstalled.addListener(async () => {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: MENU_ID,
    title: "Save highlight to SlipClip",
    // The menu cannot fire without a selection, so the empty case never
    // reaches capture from here.
    contexts: ["selection"]
  });
});

const siteOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return ""; }
};

// Capture has no UI, so the badge is the only feedback there is.
async function paintBadge() {
  const count = pending(await readHighlights()).length;
  await browser.action.setBadgeText({ text: count ? String(count) : "" });
  await browser.action.setBadgeBackgroundColor({ color: "#e8b32c" });
}

// ponytail: a timer, which a suspended worker would drop - the badge just stays
// on "!" until the next capture. Swap for an alarm if that ever misleads.
async function flashEmpty() {
  await browser.action.setBadgeBackgroundColor({ color: "#c0392b" });
  await browser.action.setBadgeText({ text: "!" });
  setTimeout(paintBadge, 1500);
}

async function captureNow({ text, url, title }) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return flashEmpty();
  if (!url) return;

  const list = await readHighlights();
  const { list: next, added } = addHighlight(list, {
    text: body,
    note: "",
    url,
    title: title || url,
    site: siteOf(url),
    author: "",
    published: "",
    created: Date.now()
  });
  if (added) await writeHighlights(next);
  return paintBadge();
}

// Two captures in the same tick would race the read-modify-write, so they queue
// behind each other - the same trick startSignIn uses to dedupe.
let queue = Promise.resolve();
function capture(input) {
  const run = () => captureNow(input);
  queue = queue.then(run, run);
  return queue;
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // info carries both, so this path needs no activeTab grant and no injection -
  // which is why it still works on pages that block extensions.
  capture({ text: info.selectionText, url: info.pageUrl || tab?.url, title: tab?.title })
    .catch((e) => console.error("highlight capture failed:", e));
});

browser.commands.onCommand.addListener(async (name, tab) => {
  if (name !== "save-highlight" || !tab?.id) return;
  try {
    // Self-contained: executeScript serialises this function's source.
    const [read] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => getSelection()?.toString() || ""
    });
    await capture({ text: read?.result, url: tab.url, title: tab.title });
  } catch (e) {
    console.error("highlight capture failed:", e);
  }
});

// A fresh worker has no badge until something repaints it.
paintBadge().catch(() => {});
```

- [ ] **Step 3: Run the suite**

Run: `cd notion-clipper-source && node test.mjs`
Expected: `ok` (background.js is not imported by the suite; this confirms nothing else broke).

- [ ] **Step 4: Manual verification**

Load the extension. Highlight a sentence, right-click → **Save highlight to SlipClip**. Expected: the badge shows `1`. Repeat with the same sentence: badge stays `1`. Press `Alt+Shift+H` with nothing selected: badge flashes `!` then returns. Reload the extension and confirm the badge still shows the count (the store is on disk, not in the worker).

- [ ] **Step 5: Commit**

```bash
git add notion-clipper-source/background.js notion-clipper-source/manifest.json
git commit -m "feat(highlights): capture selections from the context menu and a shortcut"
```

---

### Task 4: The library tab and the flush

**Files:**
- Modify: `notion-clipper-source/popup.html`
- Modify: `notion-clipper-source/popup.js`

**Interfaces:**
- Consumes: everything from `highlights.js`; `mcpTool` from `mcp.js`.
- Produces: `flushHighlights() → Promise<number>`; tab switch between Clip and Highlights.

- [ ] **Step 1: Add the tab switch to `popup.html`**

Inside `<body>`, wrap the existing clip controls in `<div id="clip-pane">` and add:

```html
<nav class="tabs">
  <button id="tab-clip" class="tab" aria-selected="true">Clip</button>
  <button id="tab-highlights" class="tab" aria-selected="false">Highlights <span id="hcount"></span></button>
</nav>

<div id="highlights-pane" hidden>
  <div id="hlist"></div>
  <button id="sync" disabled>Nothing to sync</button>
</div>
```

```css
.tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.tab { flex: 1; padding: 6px; font: inherit; font-size: 12px; color: var(--muted);
  background: none; border: 1px solid var(--edge); border-radius: 7px; cursor: pointer; }
.tab[aria-selected="true"] { color: var(--ink); border-color: var(--ink); }
.hitem { padding: 8px 0; border-bottom: 1px solid var(--edge); font-size: 12px; }
.hitem q { display: block; margin-bottom: 4px; }
.hitem cite { display: block; color: var(--muted); font-style: normal; font-size: 11px; }
.hitem button { margin-top: 4px; font: inherit; font-size: 11px; color: var(--muted);
  background: none; border: 1px solid var(--edge); border-radius: 6px; cursor: pointer; }
#sync { width: 100%; margin-top: 12px; padding: 10px; font: inherit; font-weight: 600;
  color: var(--paper); background: var(--ink); border: 0; border-radius: 9px; cursor: pointer; }
#sync:disabled { opacity: .35; cursor: not-allowed; }
```

- [ ] **Step 2: Implement the tab and the flush in `popup.js`**

```js
import { groupBySource, pending, readHighlights, writeHighlights, applyMapping } from "./highlights.js";

function showTab(which) {
  $("clip-pane").hidden = which !== "clip";
  $("highlights-pane").hidden = which !== "highlights";
  $("tab-clip").setAttribute("aria-selected", String(which === "clip"));
  $("tab-highlights").setAttribute("aria-selected", String(which === "highlights"));
}

function renderHighlights(list) {
  $("hcount").textContent = list.length ? `(${list.length})` : "";
  const box = $("hlist");
  box.replaceChildren();
  if (!list.length) {
    box.textContent = "No highlights yet. Select some text and press Alt+Shift+H.";
    return;
  }
  for (const h of list) {
    const row = document.createElement("div");
    row.className = "hitem";
    const quote = document.createElement("q");
    quote.textContent = h.text + (h.truncated ? "…" : "");
    const source = document.createElement("cite");
    source.textContent = `${h.title || h.site} · ${h.synced ? "synced" : "waiting"}`;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await writeHighlights((await readHighlights()).filter((x) => x.key !== h.key));
      renderHighlights(await readHighlights());
    });
    row.append(quote, source, del);
    box.append(row);
  }
}

// One call per flush, one row per highlight, only the unsynced ones.
async function flushHighlights() {
  const { destinations } = await browser.storage.local.get("destinations");
  const dest = destinations?.highlights;
  if (!dest?.dataSourceId) throw new Error("No highlights destination set. Open Settings.");

  const list = await readHighlights();
  const todo = pending(list);
  if (!todo.length) return 0;

  await mcpTool("notion-create-pages", {
    parent: { data_source_id: dest.dataSourceId },
    pages: todo.map((h) => ({ properties: applyMapping(h, dest.mapping) }))
  });

  // Only now is it safe to call them done: a popup killed mid-call leaves the
  // queue untouched, and the next flush retries the whole batch.
  // ponytail: a truthy marker, not the page id - nothing reads the id, and a
  // response shape change would silently stop marking them.
  const done = new Set(todo.map((h) => h.key));
  const stamped = Date.now();
  await writeHighlights(list.map((h) => (done.has(h.key) ? { ...h, synced: stamped } : h)));
  return todo.length;
}
```

- [ ] **Step 3: Wire the flush to popup open**

In the existing startup block (`popup.js` end), after `paint()`:

```js
  const { access_token } = await browser.storage.local.get("access_token");
  $("tab-clip").addEventListener("click", () => showTab("clip"));
  $("tab-highlights").addEventListener("click", () => showTab("highlights"));

  const refresh = async () => {
    const list = await readHighlights();
    renderHighlights(list);
    const waiting = pending(list).length;
    $("sync").disabled = !waiting;
    $("sync").textContent = waiting ? `Sync ${waiting} to Notion` : "Nothing to sync";
    return waiting;
  };

  if (!access_token) return refresh();

  // The popup is the app's only surface, so the queue drains here - whichever
  // tab you land on.
  try {
    const n = await flushHighlights();
    if (n) say(`Synced ${n} highlight${n > 1 ? "s" : ""}.`);
    $("sync").disabled = true;
  } catch (e) {
    say("Highlights: " + e.message, "error");
  }
  await refresh();
  $("sync").addEventListener("click", async () => {
    say("Syncing...");
    try { say(`Synced ${await flushHighlights()} highlights.`); }
    catch (e) { say("Highlights: " + e.message, "error"); }
    await refresh();
  });
```

- [ ] **Step 4: Run the suite and verify manually**

Run: `cd notion-clipper-source && node test.mjs`
Expected: `ok`.

Then: capture two highlights, open the popup, click **Highlights**. Expected: both listed as `waiting`. With no destination configured the sync line reads **No highlights destination set. Open Settings.** and the list survives closing the popup.

- [ ] **Step 5: Commit**

```bash
git add notion-clipper-source/popup.html notion-clipper-source/popup.js
git commit -m "feat(highlights): library tab and batch flush on popup open"
```

---

### Task 5: The options page

**Files:**
- Create: `notion-clipper-source/options.html`
- Create: `notion-clipper-source/options.js`
- Modify: `notion-clipper-source/test.mjs`

**Interfaces:**
- Consumes: `mcpTool`, `parseResults`, `normalizeId` from `mcp.js`; `parseDataSourceId`, `parseProperties`, `matchProperties` from `highlights.js`.
- Produces: `destinations.highlights = { dataSourceId, mapping }` in `storage.local`.

- [ ] **Step 1: Create `options.html`**

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --paper:#fff; --sunk:#f6f6f4; --edge:#e6e6e1;
    --ink:#1b1b19; --muted:#76766e; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --paper:#1b1b1a; --sunk:#252523;
    --edge:#34342f; --ink:#efefe9; --muted:#9a9a90; --bad:#ff8a75; } }
  body { max-width: 560px; margin: 0 auto; padding: 28px 20px; background: var(--paper);
    color: var(--ink); font: 400 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  label { display: block; margin-bottom: 14px; }
  .lab { display: block; margin-bottom: 5px; font-size: 10.5px; font-weight: 600;
    letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  input, select { width: 100%; padding: 8px 10px; font: inherit; color: var(--ink);
    background: var(--sunk); border: 1px solid transparent; border-radius: 8px; appearance: none; }
  button { padding: 8px 12px; font: inherit; border-radius: 8px; cursor: pointer;
    color: var(--ink); background: var(--sunk); border: 1px solid var(--edge); }
  button.primary { color: var(--paper); background: var(--ink); border: 0; }
  #status { margin-top: 16px; color: var(--muted); font-size: 12px; }
  #status[data-tone="error"] { color: var(--bad); }
  #map, #saved { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--edge); }
  .row { display: grid; grid-template-columns: 90px 1fr; gap: 10px; align-items: center;
    margin-bottom: 8px; }
  .row span { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<h1>SlipClip highlights</h1>
<p class="sub">Where your saved passages end up.</p>

<label>
  <span class="lab">Find a database</span>
  <input id="q" placeholder="Search, or paste a database link">
</label>

<label>
  <span class="lab">Database</span>
  <select id="picker"><option value="">Connect to load databases</option></select>
</label>

<button id="create">Create one for me</button>
<div id="map" hidden>
  <span class="lab">Columns</span>
  <div id="rows"></div>
  <button id="save" class="primary">Save mapping</button>
</div>
<div id="saved" hidden></div>
<div id="status"></div>

<script type="module" src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `options.js`**

```js
import { mcpTool, parseResults, normalizeId, errorText } from "./mcp.js";
import { parseDataSourceId, parseProperties, matchProperties } from "./highlights.js";

const $ = (id) => document.getElementById(id);
const say = (text, tone = "") => {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
};

let listed = [];
let schema = [];
let current = null;

function setOptions(rows) {
  const sel = $("picker");
  sel.replaceChildren();
  for (const [label, value] of rows) sel.append(new Option(label, value));
}

async function loadList(query) {
  setOptions([["Loading...", ""]]);
  try {
    const text = query
      ? await mcpTool("notion-search", { query, page_size: 25, max_highlight_length: 0 })
      : await mcpTool("notion-list-recent-pages", { limit: 25 });
    listed = parseResults(text);
    setOptions([["Pick a database", ""], ...listed.map((it) => [it.title || it.id, it.id])]);
  } catch (e) {
    say("Error: " + e.message, "error");
  }
}

const FIELDS = [["text", "Passage"], ["url", "Link"], ["created", "Date"],
  ["title", "Source"], ["author", "Author"], ["site", "Site"], ["note", "Note"]];

function renderMapping(mapping) {
  $("rows").replaceChildren();
  for (const [field, label] of FIELDS) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = label;
    const sel = document.createElement("select");
    sel.dataset.field = field;
    sel.append(new Option("not saved", ""));
    for (const p of schema) {
      const o = new Option(`${p.name} (${p.type.toLowerCase()})`, p.name);
      sel.append(o);
    }
    sel.value = mapping[field]?.name || "";
    row.append(name, sel);
    $("rows").append(row);
  }
  $("map").hidden = false;
}

const chosenMapping = () => {
  const mapping = {};
  for (const sel of $("rows").querySelectorAll("select")) {
    const prop = schema.find((p) => p.name === sel.value);
    if (prop) mapping[sel.dataset.field] = { name: prop.name, type: prop.type };
  }
  return mapping;
};

// We asked for the schema, so take the data source id from the same payload -
// once a database has more than one source, database_id is rejected.
async function useDatabase(id) {
  say("Reading the database...");
  const raw = await mcpTool("notion-fetch", { id });
  const dataSourceId = parseDataSourceId(raw);
  schema = parseProperties(raw);
  if (!dataSourceId || !schema.length) {
    throw new Error("Could not read that database's columns. Use Create one for me, or paste a database link.");
  }
  current = { dataSourceId };
  renderMapping(matchProperties(schema));
  say(`${schema.length} columns found. Check the mapping, then save.`);
}

async function saveMapping() {
  const mapping = chosenMapping();
  if (!mapping.text) return say("Pick which column should hold the passage text.", "error");
  await browser.storage.local.set({ destinations: { highlights: { ...current, mapping } } });
  $("saved").hidden = false;
  $("saved").textContent = "Saved. New highlights will sync into this database.";
  say("");
}

// The zero-config path: a schema we chose, so the mapping needs no guesswork.
async function createDatabase() {
  say("Which page should hold it? Paste its link below the search box first.");
  const parent = normalizeId($("picker").value || "");
  if (!parent) return say("Pick the parent page from the list first.", "error");
  const raw = await mcpTool("notion-create-database", {
    parent: { page_id: parent },
    title: "SlipClip Highlights",
    schema: 'CREATE TABLE ("Highlight" TITLE, "Source" RICH_TEXT, "Author" RICH_TEXT, '
      + '"Site" RICH_TEXT, "URL" URL, "Highlighted" DATE, "Note" RICH_TEXT)'
  });
  current = { dataSourceId: parseDataSourceId(raw) };
  if (!current.dataSourceId) throw new Error("Notion did not say where the new database lives.");
  schema = parseProperties(raw);
  await browser.storage.local.set({ destinations: { highlights: { ...current, mapping: matchProperties(schema) } } });
  say(`Created. ${schema.length} columns mapped and saved.`);
}

$("q").addEventListener("input", () => {
  clearTimeout($("q")._t);
  $("q")._t = setTimeout(() => loadList($("q").value.trim()), 350);
});
$("picker").addEventListener("change", (e) => {
  if (!e.target.value) return;
  useDatabase(e.target.value).catch((err) => say("Error: " + errorText(err.message), "error"));
});
$("save").addEventListener("click", () => saveMapping().catch((e) => say("Error: " + e.message, "error")));
$("create").addEventListener("click", () => createDatabase().catch((e) => say("Error: " + e.message, "error")));
loadList("");
```

- [ ] **Step 3: Run the suite**

Run: `cd notion-clipper-source && node test.mjs`
Expected: `ok`.

- [ ] **Step 4: Merge the mapping into the popup's error path**

In `popup.js`, `flushHighlights`'s "No highlights destination set" error should be actionable. Add next to the Highlights tab render:

```js
  $("openoptions").addEventListener("click", () => browser.runtime.openOptionsPage());
```

with `<button id="openoptions">Open Settings</button>` beside `#sync` in `popup.html`.

- [ ] **Step 5: Verify against a live workspace — required**

The column parser reads the `CREATE TABLE` block that `notion-fetch` returns. **Confirm this against a real database before trusting the mapping.** In the options page, paste a real database link and check that the column list populates.

If the columns come back empty, the payload shape differs from the documented DDL: log the raw `notion-fetch` response and widen the `COLUMN` regex in `highlights.js`. The empty case is a loud failure by design — it says so rather than silently mapping nothing.

- [ ] **Step 6: Commit**

```bash
git add notion-clipper-source/options.html notion-clipper-source/options.js notion-clipper-source/popup.html notion-clipper-source/popup.js
git commit -m "feat(highlights): options page for the destination database and its columns"
```

---

## Self-Review

**Spec coverage.** Capture trigger (Task 3), library tab (Task 4), storage and dedupe (Task 2), destination and mapping (Task 5), auto-flush on popup open (Task 4), shared `mcp.js` (Task 1), badge feedback (Task 3), error handling table (Tasks 4–5). Non-goals honoured: no note editor, no backend.

**Deliberate deviations from the spec, all noted in the tasks.** `synced` is a timestamp rather than the Notion page id (Task 4) — nothing consumes the id and a response-shape change would silently break marking. `id` is dropped from the record: `key` already identifies a highlight uniquely, so a generated id would be a second identity to keep in sync.

**Type consistency.** `addHighlight` returns `{ list, added }` everywhere. `pending` filters on `!h.synced`. `mapping[field]` is always `{ name, type }`. `applyMapping` reads `mapping[field].name`. `parseProperties` returns `{name, type}` which `matchProperties` consumes and `renderMapping` renders off `.type`.
