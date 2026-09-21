// The destination for saved highlights: which database, and which of its
// columns holds which field. Nothing here writes to Notion except the
// create-for-me button - everything else is configuration.

import { mcpTool, parseResults, normalizeId } from "./mcp.js";
import { parseDataSourceId, parseProperties, matchProperties } from "./highlights.js";

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
    for (const p of schema) sel.append(new Option(`${p.name} (${p.type.toLowerCase()})`, p.name));
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

function showSaved(name) {
  $("saved").hidden = false;
  $("saved").textContent = `Saving into ${name || "the selected database"}. New highlights sync there.`;
}

// We had to fetch the schema anyway, so take the data source id from the same
// payload: once a database has more than one source, database_id is rejected.
async function useDatabase(id) {
  say("Reading the database...");
  const raw = await mcpTool("notion-fetch", { id });
  const dataSourceId = parseDataSourceId(raw);
  schema = parseProperties(raw);
  if (!dataSourceId || !schema.length) {
    throw new Error("Could not read that database's columns. Pick a database rather than a page, or use Create one for me.");
  }
  current = { dataSourceId };
  renderMapping(matchProperties(schema));
  say(`${schema.length} columns found. Check the mapping, then save it.`);
}

async function saveMapping() {
  const mapping = chosenMapping();
  if (!mapping.text) return say("Pick which column should hold the passage text.", "error");
  await store({ ...current, mapping });
  showSaved(schema.find((p) => p.name === mapping.text.name)?.name);
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
  current = { dataSourceId };
  await store({ ...current, mapping: matchProperties(schema) });
  renderMapping(matchProperties(schema));
  showSaved("SlipClip Highlights");
  say(`Created with ${schema.length} columns, already mapped.`);
}

$("q").addEventListener("input", () => {
  clearTimeout($("q")._timer);
  $("q")._timer = setTimeout(() => loadList($("q").value.trim()), 350);
});

$("picker").addEventListener("change", (e) => {
  if (!e.target.value) return;
  useDatabase(e.target.value).catch((err) => say("Error: " + err.message, "error"));
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
  if (dest?.mapping?.text?.name) showSaved(dest.mapping.text.name);
  await loadList("");
})();
