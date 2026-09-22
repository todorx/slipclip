// The destination for saved highlights: which database, and which of its
// columns holds which field. Nothing here writes to Notion except the
// create-for-me button - everything else is configuration.

import { mcpTool, parseResults, normalizeId } from "./mcp.js";
import { parseDataSourceId, parseProperties, matchProperties, parseFetchKind } from "./highlights.js";

const $ = (id) => document.getElementById(id);

function say(text, tone = "") {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
}

let listed = [];
let schema = [];
let current = null;

// The fields a highlight can fill, in the order the form shows them.
const FIELDS = [
  ["text", "Passage"],
  ["url", "Link"],
  ["created", "Date"],
  ["title", "Source"],
  ["author", "Author"],
  ["site", "Site"],
  ["note", "Note"]
];

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
    setOptions([["Pick one", ""], ...listed.map((it) => [it.title || it.id, it.id])]);
  } catch (e) {
    listed = [];
    setOptions([["Could not load", ""]]);
    say("Error: " + e.message, "error");
  }
}

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
      // The passage has to be the title column, so offer nothing else for it.
      if (field === "text" && p.type !== "TITLE") continue;
      sel.append(new Option(`${p.name} (${p.type.toLowerCase()})`, p.name));
    }
    sel.value = mapping[field]?.name || "";

    row.append(name, sel);
    $("rows").append(row);
  }
  $("map").hidden = false;
}

function chosenMapping() {
  const mapping = {};
  for (const sel of $("rows").querySelectorAll("select")) {
    const prop = schema.find((p) => p.name === sel.value);
    if (prop) mapping[sel.dataset.field] = { name: prop.name, type: prop.type };
  }
  return mapping;
}

async function store(dest) {
  await browser.storage.local.set({ destinations: { highlights: dest } });
}

function showSaved(name, kind) {
  $("saved").hidden = false;
  $("saved").textContent = kind === "page"
    ? `Appending to ${name || "the selected page"}. New highlights are added to the end, grouped by source.`
    : `Saving into ${name || "the selected database"}. New highlights sync there.`;
}

// Both kinds of destination are valid and they need different things: a
// database needs its columns mapped, a page needs nothing, so it saves on the
// spot. We had to fetch the schema anyway, so take the data source id from the
// same payload: once a database has more than one source, database_id is
// rejected.
async function useDestination(id, name) {
  say("Reading that destination...");
  const raw = await mcpTool("notion-fetch", { id });
  // The name is only ever shown back to the user; a pasted link arrives without
  // one, and showSaved already has wording for that.
  const label = name?.trim() || "";

  if (parseFetchKind(raw) === "page") {
    schema = [];
    $("map").hidden = true;
    current = { kind: "page", pageId: normalizeId(id) || id, name: label };
    await store(current);
    showSaved(label, "page");
    return say("Saved. Nothing to map - passages are appended as quotes.");
  }

  const dataSourceId = parseDataSourceId(raw);
  schema = parseProperties(raw);
  if (!dataSourceId || !schema.length) {
    throw new Error("Could not read that destination. Pick a page or a database, or use Create a database for me.");
  }
  current = { kind: "database", dataSourceId, name: label };
  renderMapping(matchProperties(schema));
  say(`${schema.length} columns found. Check the mapping, then save it.`);
}

async function saveMapping() {
  const mapping = chosenMapping();
  // Notion requires a title on every row, so a passage mapped anywhere else
  // would be refused at flush time - catch it while the user is looking at it.
  if (mapping.text?.type !== "TITLE") return say("The passage has to go in the database's title column.", "error");

  // Two fields on one column means the second write silently wins - catch it
  // here rather than losing a value on every flush.
  const names = Object.values(mapping).map((m) => m.name);
  if (new Set(names).size !== names.length)
    return say("Two fields point at the same column. Give each its own, or set the extra one to “not saved”.", "error");

  await store({ ...current, mapping });
  showSaved(current.name, current.kind);
  say("");
}

// The zero-config path: a schema we chose, so there is nothing to guess at.
async function createDatabase() {
  const parent = normalizeId($("picker").value || "");
  if (!parent) return say("Pick the page that should hold it from the list first.", "error");

  say("Creating the database...");
  const raw = await mcpTool("notion-create-database", {
    parent: { page_id: parent },
    title: "SlipClip Highlights",
    schema: 'CREATE TABLE ("Highlight" TITLE, "Source" RICH_TEXT, "Author" RICH_TEXT, '
      + '"Site" RICH_TEXT, "URL" URL, "Highlighted" DATE, "Note" RICH_TEXT)'
  });

  const dataSourceId = parseDataSourceId(raw);
  if (!dataSourceId) throw new Error("Notion did not say where the new database lives.");
  schema = parseProperties(raw);
  if (!schema.length) {
    throw new Error("Notion created the database but did not report its columns. Open it once in Notion, then pick it from the list.");
  }
  current = { kind: "database", dataSourceId, name: "SlipClip Highlights" };
  const mapping = matchProperties(schema);
  await store({ ...current, mapping });
  renderMapping(mapping);
  showSaved(current.name, current.kind);
  say(`Created with ${schema.length} columns, already mapped.`);
}

// Debounced as one branch: typing an id out by hand would otherwise fire a
// notion-fetch per keystroke once the first 32 characters look like one.
$("q").addEventListener("input", () => {
  clearTimeout($("q")._timer);
  $("q")._timer = setTimeout(() => {
    const typed = $("q").value.trim();

    // Search only ever sees what was shared with the connection, so a pasted
    // link or id goes straight in rather than being searched for - otherwise a
    // database the connection cannot see is unreachable.
    if (/^https?:\/\//i.test(typed) || /^[0-9a-f-]{32,36}$/i.test(typed)) {
      const id = normalizeId(typed);
      if (id) return void useDestination(id).catch((e) => say("Error: " + e.message, "error"));
    }

    loadList(typed);
  }, 350);
});

$("picker").addEventListener("change", (e) => {
  if (!e.target.value) return;
  useDestination(e.target.value, e.target.selectedOptions[0]?.textContent)
    .catch((err) => say("Error: " + err.message, "error"));
});

$("save").addEventListener("click", () => {
  saveMapping().catch((e) => say("Error: " + e.message, "error"));
});

$("create").addEventListener("click", () => {
  createDatabase().catch((e) => say("Error: " + e.message, "error"));
});

(async () => {
  const { destinations } = await browser.storage.local.get("destinations");
  const dest = destinations?.highlights;
  if (dest?.pageId || dest?.dataSourceId) showSaved(dest.name, dest.kind ?? "database");
  await loadList("");
})();
