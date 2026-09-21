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

const COLUMN = /(?:^|[(,])\s*"([^"]+)"\s+(TITLE|RICH_TEXT|DATE|URL|EMAIL|PHONE_NUMBER|STATUS|FILES|PEOPLE|CHECKBOX|NUMBER|SELECT|MULTI_SELECT|UNIQUE_ID|CREATED_TIME|LAST_EDITED_TIME|FORMULA|RELATION|ROLLUP)\b/;

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
