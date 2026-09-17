// node test.mjs   (Node 18+, no deps)
import assert from "node:assert/strict";
import { pkceChallenge } from "./auth.js";
import { normalizeId, buildMarkdown, parseResults, optionLabel, errorText, parseChildDatabases, formatDuration } from "./popup.js";

// RFC 7636 Appendix B test vector
assert.equal(
  await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "PKCE S256 challenge must match RFC 7636"
);

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
  results: [{ type: "page", url: "https://app.notion.com/p/3d2542df8f348182a95ff06c99897f3f?pvs=204", title: "Level Up" }],
  nextCursor: "offset:4"
}));
assert.deepEqual(recent, [{ id: "3d2542df-8f34-8182-a95f-f06c99897f3f", title: "Level Up", type: "page" }]);

const searched = parseResults(JSON.stringify({
  results: [{ id: "3c5542df-8f34-81e1-b5bd-c1051adb8e6f", title: "FINKI Life", url: "https://app.notion.com/p/x", type: "page" }],
  type: "workspace_search"
}));
assert.equal(searched[0].id, "3c5542df-8f34-81e1-b5bd-c1051adb8e6f", "search results keep their own id");

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
  text: '<page url="https://app.notion.com/p/3d2542df8f348182a95ff06c99897f3f">\n<content>\n'
    + '<database url="https://app.notion.com/p/00f53eb87f084f3e82dadb177b3755e2" inline="true" data-source-url="collection://496a0caf-4816-4da9-8202-dd6dfd7a2dd3">Дневен Лог — XP Контролер</database>\n'
    + '<database url="https://app.notion.com/p/9cd5d6612e2e4e35b422caf1c98bde39" inline="true" data-source-url="collection://e9eef72d-5576-4ba2-a729-60b57557611d">Неделен Преглед — Сејв Поинт</database>\n'
    + '</content>\n</page>'
});

const kids = parseChildDatabases(fetched);
assert.equal(kids.length, 2, "both inline databases found");
assert.equal(kids[0].id, "00f53eb8-7f08-4f3e-82da-db177b3755e2", "database id, not the collection:// data source");
assert.equal(kids[0].title, "Дневен Лог — XP Контролер");
assert.equal(kids[1].id, "9cd5d661-2e2e-4e35-b422-caf1c98bde39");
assert.ok(kids.every((k) => k.type === "database"));
assert.deepEqual(parseChildDatabases("a page with no databases"), [], "pages without databases yield nothing");

// Bare markup, no JSON wrapper.
assert.equal(
  parseChildDatabases('<database url="https://app.notion.com/p/00f53eb87f084f3e82dadb177b3755e2">Log</database>')[0].id,
  "00f53eb8-7f08-4f3e-82da-db177b3755e2"
);

// Markup nested somewhere other than `text`.
assert.equal(
  parseChildDatabases(JSON.stringify({ blocks: { body: '<database url="https://app.notion.com/p/00f53eb87f084f3e82dadb177b3755e2">Log</database>' } }))[0].title,
  "Log"
);

// Real Notion validation error: the whole blob is noise except `message`.
const apiError = JSON.stringify({
  name: "APIResponseError",
  code: "validation_error",
  body: "{\"object\":\"error\",\"status\":400}",
  request_id: "9f8beda5-6ee2-4ceb-b2f7-1dbe68761900",
  message: "Provided database_id 3d2542df-8f34-8182-a95f-f06c99897f3f is a page, not a database."
});
assert.equal(errorText(apiError), "Provided database_id 3d2542df-8f34-8182-a95f-f06c99897f3f is a page, not a database.");
assert.equal(errorText("plain text failure"), "plain text failure", "unparseable errors pass through");
assert.ok(/not a (page|database)/i.test(errorText(apiError)), "clip's retry trigger must match this wording");

console.log("ok");
