// Clipping, shared by the popup and the background worker's shortcut and
// context menu. Everything that shapes a Notion write is pure and covered by
// test.mjs; the calls that touch the tab, storage or Notion come last.

import { extractPage } from "./extract.js";
import { mcpTool, normalizeId } from "./mcp.js";
import { applyMapping, canonicalUrl, matchProperties, parseDataSourceId, parseProperties, quoteLines } from "./highlights.js";

export const CLIPS_KEY = "clipped";
const CLIPS_CAP = 500;

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

// A note is yours, not the page's, so it sits apart in a callout. Notion's
// markup reads a bare newline as a new block and < as a tag, so both are
// rewritten.
export const noteCallout = (note) =>
  `<callout icon="💬">\n\t${note.trim().replace(/[<>]/g, "\\$&").replace(/\r?\n/g, "<br>")}\n</callout>`;

// `heading` turns the source line into an H2 - appended clips need a visible
// break between them, a new page does not.
export function buildMarkdown(page, { heading = false } = {}) {
  const { url, title, description, selection, siteName, author, published, duration, body, truncated, kind, note } = page;
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
    note?.trim() && noteCallout(note),
    meat,
    truncated && !selection && "*Article truncated.*"
  ].filter(Boolean).join("\n\n");
}

// The columns a clip can fill. The title, the link and tags are guessed by type
// - a database has one title, and one url or tags column is the common shape.
// The rest need a column named for them, so a stray "Date" is never taken for
// the publication date.
const CLIP_RULES = [
  ["text",      (p) => p.type === "TITLE",        /name|title/i,                               true],
  ["url",       (p) => p.type === "URL",          /url|link/i,                                 true],
  ["published", (p) => p.type === "DATE",         /publish|posted|released|aired/i,            false],
  ["author",    (p) => p.type === "RICH_TEXT",    /author|byline|writer|creator|channel/i,     false],
  ["site",      (p) => p.type === "RICH_TEXT",    /site|publication|domain|publisher|source/i, false],
  ["note",      (p) => p.type === "RICH_TEXT",    /note|comment|thought/i,                     false],
  ["tags",      (p) => p.type === "MULTI_SELECT", /tag|label|topic|categor/i,                  true]
];

// The column the popup offers tags for, options included.
export function tagsColumn(properties) {
  const name = matchProperties(properties, CLIP_RULES).tags?.name;
  return properties.find((p) => p.name === name) || null;
}

// A database row has columns a page does not. applyMapping already knows that
// "URL" needs its userDefined: prefix; dates and tags are spelled out here.
export function clipProperties(page, properties, { tags = [] } = {}) {
  const m = matchProperties(properties, CLIP_RULES);
  const props = applyMapping({ text: page.title, url: page.url, author: page.author, site: page.siteName, note: page.note }, m);

  // Columns that could not be read still leave Notion's title alias.
  if (!m.text) props.title = page.title;
  if (m.published && /^\d{4}-\d{2}-\d{2}$/.test(page.published || "")) {
    props[`date:${m.published.name}:start`] = page.published;
    props[`date:${m.published.name}:is_datetime`] = 0;
  }
  // A multi-select is a JSON array in Notion's SQLite view of the row.
  if (m.tags && tags.length) props[m.tags.name] = JSON.stringify(tags);
  return props;
}

// Notion refuses a tag its column does not list yet ("the data source must be
// updated to add it"), so new tags are added to the column first. SET replaces
// the whole list, so every existing option is restated with its color - one
// left out would be stripped from every row that has it. Without a known list
// there is nothing safe to restate, so nothing is changed.
export function addTagsStatement(column, tags) {
  if (!column || !Array.isArray(column.options)) return "";
  const have = new Set(column.options.map((o) => o.name));
  const fresh = [...new Set(tags)].filter((t) => !have.has(t));
  if (!fresh.length) return "";
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const options = [
    ...column.options.map((o) => `${quote(o.name)}:${o.color || "default"}`),
    ...fresh.map((t) => `${quote(t)}:default`)
  ];
  return `ALTER COLUMN "${column.name.replace(/"/g, '""')}" SET MULTI_SELECT(${options.join(", ")})`;
}

// Where the clip landed. notion-create-pages answers with the new page; when no
// page can be read out of the answer - or for an append - the destination itself
// is the link.
export function notionLink(raw, fallbackId) {
  try {
    const page = JSON.parse(raw)?.pages?.[0];
    if (page?.url) return page.url;
    const id = normalizeId(page?.id);
    if (id) return `https://www.notion.so/${id.replace(/-/g, "")}`;
  } catch { /* markup rather than JSON; look for a link in it */ }
  const found = /https:\/\/(?:app\.notion\.com|(?:www\.)?notion\.so)\/[^\s"'<>)\]}]+/.exec(String(raw ?? ""));
  if (found) return found[0];
  const id = normalizeId(fallbackId);
  return id ? `https://www.notion.so/${id.replace(/-/g, "")}` : "";
}

// Newest first, one row per page, so a second visit can say "already clipped".
// ponytail: capped rather than indexed - a clip older than the last 500 is
// clipped again without a warning.
export function rememberClip(list, url, link, at = Date.now()) {
  const key = canonicalUrl(url);
  return [{ key, link, at }, ...list.filter((c) => c.key !== key)].slice(0, CLIPS_CAP);
}

export const findClip = (list, url) => list.find((c) => c.key === canonicalUrl(url)) || null;

export async function readClips() {
  const { [CLIPS_KEY]: list } = await browser.storage.local.get(CLIPS_KEY);
  return Array.isArray(list) ? list : [];
}

// ---------- calls ----------

export async function getTabData(tabId) {
  const target = { tabId };

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

// One read per destination per popup or worker lifetime: the popup reads it to
// offer tags, and the clip reuses it for the columns and the data source.
// ponytail: never invalidated, so a column added mid-session is missed until the
// popup reopens; the worker is suspended within seconds of going idle anyway.
const destinations = new Map();
export function readDestination(id) {
  if (!destinations.has(id)) {
    destinations.set(id, mcpTool("notion-fetch", { id }).catch((e) => {
      destinations.delete(id);
      throw e;
    }));
  }
  return destinations.get(id);
}

// One clip, start to finish. `known` is the destination's kind when the picker
// said so; a pasted link leaves it empty and Notion's error settles it. Returns
// where the clip landed and, once settled, what the destination turned out to be.
export async function clipTo(tabId, { parentId, known = "", mode = "child", title = "", note = "", tags = [] }) {
  const tab = await getTabData(tabId);
  const page = { ...tab, title: (title.trim() || tab.title || "Untitled clip").slice(0, 100), note };
  let raw = "";
  let kind = known;

  if (mode === "append") {
    // allow_async defaults true here, which would answer with a task instead of
    // a result. A clip is small enough to just wait for.
    await mcpTool("notion-update-page", {
      page_id: parentId,
      command: "insert_content",
      content: buildMarkdown(page, { heading: true }),
      position: { type: "end" },
      allow_async: false
    });
  } else {
    const looks = {
      content: buildMarkdown(page),
      ...(tab.icon && { icon: tab.icon }),
      ...(tab.image && { cover: tab.image })
    };
    // A database with more than one data source refuses database_id, and the
    // fetch that reads the columns names the source anyway.
    const intoDatabase = async () => {
      let schema = await readDestination(parentId);
      const source = parseDataSourceId(schema);
      kind = "database";

      // The options are restated from a fresh read, never the cached one: an
      // option added in Notion since the popup opened would otherwise be dropped.
      if (addTagsStatement(tagsColumn(parseProperties(schema)), tags)) {
        destinations.delete(parentId);
        schema = await readDestination(parentId);
        const statements = addTagsStatement(tagsColumn(parseProperties(schema)), tags);
        if (statements) await mcpTool("notion-update-data-source", { data_source_id: source || parentId, statements });
        destinations.delete(parentId);
      }

      return mcpTool("notion-create-pages", {
        parent: source ? { data_source_id: source } : { database_id: parentId },
        pages: [{ properties: clipProperties(page, parseProperties(schema), { tags }), ...looks }],
        allow_async: false
      });
    };

    if (known === "database") raw = await intoDatabase();
    else {
      try {
        raw = await mcpTool("notion-create-pages", {
          parent: { page_id: parentId },
          pages: [{ properties: { title: page.title }, ...looks }],
          allow_async: false
        });
        kind = "page";
      } catch (e) {
        // A pasted link doesn't say which kind it is. Notion's error does, so one
        // retry beats making the user classify it.
        if (known || !/not a (page|database)/i.test(e.message)) throw e;
        raw = await intoDatabase();
      }
    }
  }

  const link = notionLink(raw, parentId);
  await browser.storage.local.set({ [CLIPS_KEY]: rememberClip(await readClips(), tab.url, link) });
  return { link, kind };
}
