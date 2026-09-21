// node test.mjs   (Node 18+, no deps)
import assert from "node:assert/strict";
import { pkceChallenge, hasWebAuthFlow, redirectUri, completeSignIn } from "./auth.js";
import { normalizeId, parseResults, errorText, unwrapPayload } from "./mcp.js";
import { buildMarkdown, optionLabel, parseChildDatabases, formatDuration } from "./popup.js";
import { extractPage } from "./extract.js";
import { canonicalUrl, siteOf, addHighlight, pending, groupBySource, applyMapping, parseDataSourceId, parseProperties, matchProperties, coalesce, flushPending, readHighlights, writeHighlights } from "./highlights.js";

// RFC 7636 Appendix B test vector
assert.equal(
  await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "PKCE S256 challenge must match RFC 7636"
);

// Firefox for Android ships no identity API, so sign-in falls back to the
// hosted callback. The client is registered against whichever redirect this
// environment uses - Notion rejects any other one.
assert.equal(hasWebAuthFlow(), false, "Node has no identity API");
assert.equal(redirectUri(), "https://slipclip.todorx.dev/oauth-callback/", "no identity picks the hosted callback");
globalThis.browser = { identity: { launchWebAuthFlow() {}, getRedirectURL: () => "https://abc123.extensions.allizom.org/" } };
assert.equal(redirectUri(), "https://abc123.extensions.allizom.org/", "identity present keeps the extension redirect");
delete globalThis.browser;

// The Android flow is resumed from storage by a tabs.onUpdated event, so the
// guard deciding "is this my redirect?" is what keeps it from firing on
// unrelated tabs - and from exchanging a code the state check rejects.
const store = {
  auth_pending: {
    tab_id: 7,
    client_id: "client-1",
    verifier: "verifier-1",
    state: "state-1",
    redirect_uri: "https://slipclip.todorx.dev/oauth-callback/"
  }
};
globalThis.browser = {
  storage: { local: {
    get: async (k) => ({ [k]: store[k] }),
    set: async (o) => Object.assign(store, o),
    remove: async (k) => { delete store[k]; }
  } },
  tabs: { remove: async () => {} }
};

assert.equal(await completeSignIn(9, "https://slipclip.todorx.dev/oauth-callback/?code=x&state=state-1"), false, "another tab's redirect is ignored");
assert.equal(await completeSignIn(7, "https://example.com/"), false, "another url is ignored");
assert.equal(store.auth_pending.tab_id, 7, "an ignored update leaves the flow parked");
assert.match(store.auth_error || "", /^$/, "and records no error");

assert.equal(await completeSignIn(7, "https://slipclip.todorx.dev/oauth-callback/?code=x&state=wrong"), true, "our redirect is claimed");
assert.match(store.auth_error, /State mismatch/, "a mismatched state aborts before any exchange");
assert.ok(!store.auth_pending, "the parked flow is cleared either way");
delete globalThis.browser;

assert.equal(
  normalizeId("https://www.notion.so/Some-Page-0123456789abcdef0123456789abcdef"),
  "01234567-89ab-cdef-0123-456789abcdef"
);
assert.equal(normalizeId("not a notion link"), null);

// A selection outranks everything: you asked for that passage, not the page.
const picked = buildMarkdown({
  url: "https://example.com/a",
  title: "Example",
  description: "A description.",
  body: "# Whole article\n\nParagraphs and paragraphs.",
  selection: "First line\nSecond line"
});
assert.match(picked, /https:\/\/example\.com\/a/, "the source URL always survives");
assert.ok(picked.split("\n").some((l) => l.startsWith(">")), "selection is quoted");
assert.ok(!picked.includes("Whole article"), "body is dropped when a passage was chosen");
assert.ok(!picked.includes("A description."), "description is dropped too");

// No selection: the extracted article wins over the meta description.
const read = buildMarkdown({
  url: "https://example.com/a",
  title: "Example",
  description: "A description.",
  body: "# Whole article\n\nParagraphs and paragraphs.",
  selection: "",
  siteName: "Example Times",
  author: "A. Writer",
  published: "2026-04-01"
});
assert.match(read, /\*Example Times · A\. Writer · 2026-04-01\*/, "facts line renders");
assert.ok(read.includes("Whole article"), "article body is included");
assert.ok(!read.includes("A description."), "description yields to the body");

// Video: no body was ever extracted, so the description carries the clip.
const watched = buildMarkdown({
  url: "https://youtube.com/watch?v=x",
  title: "Some Talk",
  description: "What the talk covers.",
  selection: "",
  body: "",
  author: "A Channel",
  published: "2026-03-02",
  duration: "PT1H2M3S"
});
assert.match(watched, /\*A Channel · 2026-03-02 · 1:02:03\*/, "duration is formatted into the facts line");
assert.ok(watched.includes("What the talk covers."), "description carries a video clip");

// An index page keeps its blurb AND its links - the links are the content.
const listing = buildMarkdown({
  url: "https://example.gov/orders/2026",
  title: "Executive Orders",
  description: "Orders signed in 2026.",
  selection: "",
  kind: "index",
  body: ["- [Order 14100](https://example.gov/a)", "- [Order 14101](https://example.gov/b)"].join("\n"),
  siteName: "Federal Register"
});
assert.ok(listing.includes("Orders signed in 2026."), "index keeps its blurb");
assert.ok(listing.includes("- [Order 14100]"), "index keeps its links");

assert.equal(formatDuration("PT12M34S"), "12:34");
assert.equal(formatDuration("PT45S"), "0:45");
assert.equal(formatDuration("PT2H"), "2:00:00");
assert.equal(formatDuration(""), "", "missing duration renders nothing");
assert.equal(formatDuration("nonsense"), "", "unparseable duration renders nothing");

// Append mode: the source line becomes an H2 so stacked clips stay separable.
const appended = buildMarkdown(
  { url: "https://example.com/a", title: "Example", description: "Desc.", selection: "" },
  { heading: true }
);
assert.ok(appended.startsWith("## [Example](https://example.com/a)"), "heading mode renders an H2 link");
assert.ok(!picked.startsWith("##"), "default stays a plain link");

const bare = buildMarkdown({ url: "https://example.com/a", title: "Example", description: "", selection: "" });
assert.match(bare, /https:\/\/example\.com\/a/, "URL survives with nothing else to say");
assert.ok(!bare.includes(">"), "no empty quote block when there is no selection");
assert.ok(!/\n\n\n/.test(bare), "no stacked blank lines from skipped sections");

// Real payloads: notion-list-recent-pages has no `id`, notion-search does.
const recent = parseResults(JSON.stringify({
  results: [{ type: "page", url: "https://app.notion.com/p/11111111111141118111111111111111?pvs=204", title: "Example Page" }],
  nextCursor: "offset:4"
}));
assert.deepEqual(recent, [{ id: "11111111-1111-4111-8111-111111111111", title: "Example Page", type: "page" }]);

const searched = parseResults(JSON.stringify({
  results: [{ id: "22222222-2222-4222-8222-222222222222", title: "Example Search Result", url: "https://app.notion.com/p/x", type: "page" }],
  type: "workspace_search"
}));
assert.equal(searched[0].id, "22222222-2222-4222-8222-222222222222", "search results keep their own id");

assert.deepEqual(parseResults(""), [], "empty response is not a crash");
assert.deepEqual(parseResults(JSON.stringify({ results: [{ title: "No id anywhere" }] })), [], "unusable rows are dropped");

assert.equal(optionLabel({ title: "Life Plan", type: "page" }), "Life Plan");
assert.equal(optionLabel({ title: "Tasks", type: "database" }), "Tasks (database)");
assert.equal(optionLabel({ title: "   ", type: "page" }), "Untitled");
assert.ok(optionLabel({ title: "x".repeat(80), type: "page" }).length <= 48, "long titles truncated");

// Real notion-fetch payload: inline databases as <database> tags. The tag also
// carries data-source-url=, which must NOT be mistaken for the database id.
const fetched = JSON.stringify({
  metadata: { type: "page" },
  text: '<page url="https://app.notion.com/p/11111111111141118111111111111111">\n<content>\n'
    + '<database url="https://app.notion.com/p/33333333333343338333333333333333" inline="true" data-source-url="collection://55555555-5555-4555-8555-555555555555">Example Database A</database>\n'
    + '<database url="https://app.notion.com/p/44444444444444448444444444444444" inline="true" data-source-url="collection://66666666-6666-4666-8666-666666666666">Example Database B</database>\n'
    + '</content>\n</page>'
});

const kids = parseChildDatabases(fetched);
assert.equal(kids.length, 2, "both inline databases found");
assert.equal(kids[0].id, "33333333-3333-4333-8333-333333333333", "database id, not the collection:// data source");
assert.equal(kids[0].title, "Example Database A");
assert.equal(kids[1].id, "44444444-4444-4444-8444-444444444444");
assert.ok(kids.every((k) => k.type === "database"));
assert.deepEqual(parseChildDatabases("a page with no databases"), [], "pages without databases yield nothing");

// MCP results arrive either as markup already or wrapped in a JSON blob.
assert.equal(unwrapPayload(JSON.stringify({ text: "<p>x</p>" })), "<p>x</p>", "JSON-wrapped markup unwraps");
assert.equal(unwrapPayload("<p>x</p>"), "<p>x</p>", "bare markup passes through");
assert.equal(unwrapPayload(""), "", "an empty payload is not a crash");

// Bare markup, no JSON wrapper.
assert.equal(
  parseChildDatabases('<database url="https://app.notion.com/p/33333333333343338333333333333333">Log</database>')[0].id,
  "33333333-3333-4333-8333-333333333333"
);

// Markup nested somewhere other than `text`.
assert.equal(
  parseChildDatabases(JSON.stringify({ blocks: { body: '<database url="https://app.notion.com/p/33333333333343338333333333333333">Log</database>' } }))[0].title,
  "Log"
);

// Real Notion validation error: the whole blob is noise except `message`.
const apiError = JSON.stringify({
  name: "APIResponseError",
  code: "validation_error",
  body: "{\"object\":\"error\",\"status\":400}",
  request_id: "77777777-7777-4777-8777-777777777777",
  message: "Provided database_id 11111111-1111-4111-8111-111111111111 is a page, not a database."
});
assert.equal(errorText(apiError), "Provided database_id 11111111-1111-4111-8111-111111111111 is a page, not a database.");
assert.equal(errorText("plain text failure"), "plain text failure", "unparseable errors pass through");
assert.ok(/not a (page|database)/i.test(errorText(apiError)), "clip's retry trigger must match this wording");

// --- highlights ---

// Tracking parameters and fragments differ per share link for one article.
assert.equal(
  canonicalUrl("https://www.Example.com/Post/?utm_source=x&utm_medium=y#top"),
  canonicalUrl("https://example.com/Post"),
  "fragments, www and tracking params are not part of a page's identity"
);
assert.equal(canonicalUrl("https://example.com/a?page=2"), "https://example.com/a?page=2", "a meaningful query parameter survives");
assert.equal(canonicalUrl("not a url"), "not a url", "unparseable input is passed through");

assert.equal(siteOf("https://www.example.com/a/b"), "example.com", "the www is not part of the site");
assert.equal(siteOf("https://News.Example.COM/x"), "news.example.com", "host case is normalised");
assert.equal(siteOf("not a url"), "", "an unparseable url yields no site");

// A passage saved twice is one highlight; the same passage in two articles is two.
const articleA = "https://example.com/a";
const articleB = "https://example.com/b";
let library = [];
library = addHighlight(library, { text: "One sentence.", url: articleA, title: "A" }).list;
library = addHighlight(library, { text: "One sentence.", url: articleA + "?utm_source=t", title: "A" }).list;
assert.equal(library.length, 1, "the same passage from a tracking-parameter URL is a duplicate");

library = addHighlight(library, { text: "Another sentence.", url: articleA, title: "A" }).list;
assert.equal(library.length, 2, "a different passage from the same page is not");

library = addHighlight(library, { text: "One sentence.", url: articleB, title: "B" }).list;
assert.equal(library.length, 3, "the same passage from another page is not");

const dupe = addHighlight(library, { text: "One sentence.", url: articleA, title: "A" });
assert.equal(dupe.added, false, "a duplicate reports itself");
assert.equal(dupe.list.length, 3, "and does not grow the store");

// Notion rejects a rich-text value over 2000 characters.
const long = addHighlight([], { text: "x".repeat(2500), url: articleA, title: "A" }).list[0];
assert.equal(long.text.length, 2000, "text is capped at the API limit");
assert.equal(long.truncated, true, "and says so");
assert.equal(addHighlight([], { text: "short", url: articleA, title: "A" }).list[0].truncated, false);

assert.equal(pending(library).length, 3, "everything starts unsynced");
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

// Storage round-trip. readHighlights must survive junk in the slot.
const hStore = {};
globalThis.browser = { storage: { local: {
  get: async (k) => ({ [k]: hStore[k] }),
  set: async (o) => Object.assign(hStore, o)
} } };
assert.deepEqual(await readHighlights(), [], "an empty store reads as an empty list");
await writeHighlights([{ key: "a" }]);
assert.deepEqual(await readHighlights(), [{ key: "a" }], "what was written comes back");
hStore.highlights = "nonsense";
assert.deepEqual(await readHighlights(), [], "junk in the slot is not a crash");
delete globalThis.browser;

// matchProperties does not guess. A rich_text column that is not named for a
// field stays unmapped, because the form asks rather than invents.
const vague = matchProperties(parseProperties(JSON.stringify({
  text: 'CREATE TABLE ("Name" TITLE, "Created" DATE, "Extra" RICH_TEXT, "URL" URL)'
})));
assert.equal(vague.text.name, "Name");
assert.ok(!vague.title, "an unnamed rich_text column is not taken for the source title");
assert.ok(!vague.note, "nor for the note");

// A one-line schema has to yield every column, not just the first.
const inlineSchema = 'CREATE TABLE ("Highlight" TITLE, "URL" URL, "Highlighted" DATE, "Note" RICH_TEXT)';
assert.equal(parseProperties(inlineSchema).length, 4, "a single-line schema yields every column");
assert.equal(parseProperties(inlineSchema)[3].name, "Note");

// coalesce: a second sync while one is in flight joins it rather than starting
// a second write of the same queue.
let runs = 0;
const slow = coalesce(async () => {
  runs++;
  await new Promise((r) => setTimeout(r, 5));
  return "done";
});
assert.deepEqual(await Promise.all([slow(), slow()]), ["done", "done"], "both callers get the result");
assert.equal(runs, 1, "but the work happens once");
await slow();
assert.equal(runs, 2, "and once it settles, the next call runs again");

// flushPending: the storage choreography, exercised without a network.
const fStore = {};
globalThis.browser = { storage: { local: {
  get: async (k) => ({ [k]: fStore[k] }),
  set: async (o) => Object.assign(fStore, o)
} } };

assert.equal(
  await flushPending(async () => { throw new Error("must not be called"); }),
  0,
  "an empty queue makes no call at all"
);

fStore.highlights = [
  { key: "a", text: "A", synced: null },
  { key: "b", text: "B", synced: null }
];
const batches = [];
await flushPending(async (batch) => {
  batches.push(batch.map((h) => h.key));
  // A capture lands while the request is in flight.
  fStore.highlights = [{ key: "c", text: "C", synced: null }, ...fStore.highlights];
});
assert.deepEqual(batches, [["a", "b"]], "the pending highlights are sent");
assert.deepEqual(fStore.highlights.map((h) => h.key), ["c", "a", "b"],
  "a capture during the flush survives the stamp");
assert.equal(fStore.highlights[0].synced, null, "and stays queued");
assert.ok(fStore.highlights[1].synced && fStore.highlights[2].synced, "while what was sent is stamped");

assert.equal(
  await flushPending(async (batch) => { batches.push(batch.map((h) => h.key)); }),
  1,
  "the next flush sends only what is still pending"
);
assert.deepEqual(batches[1], ["c"]);

// A long queue is chunked rather than sent as one unbounded call.
fStore.highlights = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, synced: null }));
const sizes = [];
await flushPending(async (batch) => { sizes.push(batch.length); }, { chunkSize: 2 });
assert.deepEqual(sizes, [2, 2, 1], "a large queue is sent in chunks");
assert.equal(pending(fStore.highlights).length, 0, "and all of it is stamped");

delete globalThis.browser;

// extractPage() runs inside the page and is serialized by executeScript, so it
// stays self-contained - which is also why plain Node cannot run it without a
// DOM. The fakes below are the smallest page that reaches the turndown rules:
// no metadata anywhere, and a Readability handing back one paragraph. The rules
// are then exercised against fake image nodes, so these assertions run against
// the real extractPage(), not a copy of it.
let fakeService;
let gfmApplied = false;

class FakeTurndown {
  constructor() { fakeService = this; this.rules = {}; }
  addRule(key, rule) { this.rules[key] = rule; return this; }
  // Long enough that the index-page fallback stays out of the way.
  turndown() { return "x".repeat(700); }
}

globalThis.document = {
  title: "Fake",
  querySelector: () => null,
  querySelectorAll: () => [],
  cloneNode: () => globalThis.document
};
globalThis.location = { href: "https://example.com/post" };
globalThis.getSelection = () => null;
globalThis.Readability = class { parse() { return { content: "<p>body</p>" }; } };
globalThis.TurndownService = FakeTurndown;
globalThis.turndownPluginGfm = { gfm: () => { gfmApplied = true; } };

const scraped = extractPage();

assert.ok(gfmApplied, "the GFM extensions are applied to the converter");
assert.ok(scraped.body.length >= 600, "the converted body survives the index-page check");

const img = (attrs) => ({ getAttribute: (name) => attrs[name] ?? null });
const image = fakeService.rules.lazyImage;
assert.ok(image, "extractPage registers a lazy-image rule");

assert.equal(
  image.replacement("", img({ src: "https://cdn.example.com/real.png" })),
  "![](https://cdn.example.com/real.png)"
);
assert.equal(
  image.replacement("", img({ src: "data:image/gif;base64,R0lGOD", "data-src": "https://cdn.example.com/real.png" })),
  "![](https://cdn.example.com/real.png)",
  "a placeholder src yields to data-src"
);
assert.equal(
  image.replacement("", img({ src: "https://cdn.example.com/tiny.gif", srcset: "https://cdn.example.com/s.jpg 1x, https://cdn.example.com/l.jpg 2x" })),
  "![](https://cdn.example.com/l.jpg)",
  "the last srcset candidate is the largest"
);
assert.equal(
  image.replacement("", img({ src: "data:image/gif;base64,R0lGOD" })),
  "",
  "a bare data: placeholder is dropped rather than linked"
);
assert.equal(
  image.replacement("", img({ "data-src": "/rel/pic.png" })),
  "![](https://example.com/rel/pic.png)",
  "relative URLs are absolutized against the page"
);
assert.equal(
  image.replacement("", img({ alt: "a[b] c", src: "https://cdn.example.com/x.png" })),
  "![a\\[b\\] c](https://cdn.example.com/x.png)",
  "brackets in alt are escaped"
);
assert.equal(
  image.replacement("", img({ src: "http://[bad" })),
  "",
  "an unparseable src drops the image, not the article"
);

delete globalThis.document;
delete globalThis.location;
delete globalThis.getSelection;
delete globalThis.Readability;
delete globalThis.TurndownService;
delete globalThis.turndownPluginGfm;

console.log("ok");
