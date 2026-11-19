// Runs inside the page. scripting.executeScript serializes this function's
// source, so it must not reference anything outside itself. Readability and
// turndown are injected as files first and exist as globals in the same world.
export function extractPage() {
  const meta = (key) =>
    document.querySelector(`meta[property="${key}"]`)?.content?.trim() ||
    document.querySelector(`meta[name="${key}"]`)?.content?.trim() ||
    "";

  // Pages declare what they are in JSON-LD. That, not a text heuristic, is how
  // a video page avoids the article walker.
  const linked = [];
  for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(tag.textContent);
      linked.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      for (const node of parsed?.["@graph"] || []) linked.push(node);
    } catch { /* malformed JSON-LD is everywhere; ignore it */ }
  }
  const typeOf = (node) => [].concat(node?.["@type"] || []).join(" ");
  const find = (re) => linked.find((node) => re.test(typeOf(node))) || null;

  // YouTube and others put video facts in microdata, not JSON-LD.
  const micro = (prop) => {
    const el = document.querySelector(`[itemprop="${prop}"]`);
    return (el?.getAttribute("content") || el?.textContent || "").trim();
  };
  const hasVideoMicrodata = Boolean(document.querySelector('[itemtype*="VideoObject" i]'));

  const video = find(/VideoObject/i);
  const article = find(/Article|BlogPosting|NewsArticle/i);
  const ogType = meta("og:type");

  const kind =
    video || hasVideoMicrodata || ogType.startsWith("video") ? "video" :
    article || ogType === "article" || document.querySelector("article") ? "article" :
    "link";

  const nameOf = (value) =>
    Array.isArray(value) ? value.map(nameOf).filter(Boolean).join(", ")
    : typeof value === "string" ? value.trim()
    : typeof value?.name === "string" ? value.name.trim()
    : "";

  // Notion takes a cover or an icon only as an external http(s) address up to
  // 2000 characters, so a relative path is resolved and anything else - data:
  // placeholders or oversized signed URLs - dropped.
  const absolute = (src) => {
    if (!src) return "";
    try {
      const u = new URL(src, location.href);
      return /^https?:$/.test(u.protocol) && u.href.length <= 2000 ? u.href : "";
    } catch { return ""; }
  };

  const mdHref = (href) => href.replace(/\(/g, "%28").replace(/\)/g, "%29");

  const page = {
    url: location.href,
    title: (meta("og:title") || micro("name") || document.title || "").trim(),
    description: (meta("og:description") || micro("description") || meta("description") || "").trim().slice(0, 1200),
    siteName: meta("og:site_name"),
    author: nameOf(video?.author ?? article?.author) || micro("channelName") || micro("author") || meta("author"),
    published: String(video?.uploadDate || article?.datePublished || micro("uploadDate") || meta("article:published_time") || "").slice(0, 10),
    duration: (typeof video?.duration === "string" ? video.duration : "") || micro("duration"),
    selection: (getSelection()?.toString().trim() || "").slice(0, 10000),
    image: absolute(meta("og:image") || meta("twitter:image")),
    icon: absolute(document.querySelector('link[rel="apple-touch-icon"], link[rel~="icon"]')?.getAttribute("href")),
    kind,
    body: "",
    truncated: false
  };

  // A highlighted passage is an explicit "just this", and a video page is
  // chrome, comments and recommendations. Neither is worth walking.
  if (kind === "video" || page.selection) return page;

  // Prose length ignoring link text, so a page that is mostly links reads as
  // short however many words its anchors hold.
  const proseLength = (markdown) =>
    markdown.replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim().length;

  // An index page - a list of orders, posts, results - has no prose for
  // Readability to find. Its links are the content.
  const collectLinks = () => {
    const root = document.querySelector("main, [role='main'], #main-content, #main, article") || document.body;
    if (!root) return "";
    const scope = root.cloneNode(true);
    for (const junk of scope.querySelectorAll(
      "nav, header, footer, aside, script, style, noscript, form, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], [aria-hidden='true']"
    )) junk.remove();

    const seen = new Set();
    const rows = [];
    for (const anchor of scope.querySelectorAll("a[href]")) {
      const href = anchor.href;
      const text = anchor.textContent.replace(/\s+/g, " ").trim();
      if (typeof href !== "string" || !/^https?:/.test(href) || href === location.href) continue;
      if (text.length < 3 || text.length > 140 || seen.has(href)) continue;
      seen.add(href);
      rows.push(`- [${text.replace(/[[\]]/g, "\\$&")}](${mdHref(href)})`);
      if (rows.length === 150) break;
    }
    return rows.join("\n");
  };

  try {
    const parsed = new Readability(document.cloneNode(true), { charThreshold: 200 }).parse();
    if (parsed?.content) {
      const service = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        hr: "---"
      });

      // Tables, strikethrough and task lists are GitHub extensions. Core
      // turndown has none of them, so a <table> arrives as a run of
      // unreadable text.
      turndownPluginGfm.gfm(service);

      // turndown-plugin-gfm crashes on empty <table> elements (node.rows[0] is
      // undefined) and keeps headerless tables as raw HTML <table>...</table>,
      // which Notion's XML-based Markdown parser can reject. Handle both before
      // gfm's table rule or keep() runs.
      service.addRule("safeTable", {
        filter: (node) => {
          if (node.nodeName !== "TABLE") return false;
          const first = node.rows?.[0];
          if (!first) return true;
          const p = first.parentNode;
          const isHeader = p?.nodeName === "THEAD" || (
            p?.firstChild === first &&
            (p.nodeName === "TABLE" || p.nodeName === "TBODY") &&
            Array.from(first.childNodes || []).every((n) => n.nodeName === "TH")
          );
          return !isHeader;
        },
        replacement: (content, node) => {
          if (!node.rows?.length) return "";
          const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return "";
          const cols = Math.max(1, (lines[0].match(/\|/g) || []).length - 1);
          const sep = "| " + Array(cols).fill("---").join(" | ") + " |";
          return "\n\n" + [lines[0], sep, ...lines.slice(1)].join("\n") + "\n\n";
        }
      });

      // Most sites park the real image in a data-* attribute and serve a
      // placeholder in src, which the built-in rule reads blindly - so a lazy
      // image arrives broken or not at all. Added after gfm so it wins.
      service.addRule("lazyImage", {
        filter: "img",
        replacement: (content, node) => {
          const at = (name) => (node.getAttribute(name) || "").trim();
          // "url-a 1x, url-b 2x" - the last candidate is the largest.
          const widest = (set) => set.split(",").pop().trim().split(/\s+/)[0];
          const src = at("data-src") || at("data-original") || at("data-lazy-src")
            || widest(at("srcset")) || widest(at("data-srcset")) || at("src");

          // A data: URI is a placeholder or a tracking pixel, and Notion
          // cannot render one.
          if (!src || src.startsWith("data:")) return "";

          // An unparseable src is not worth losing the whole article over.
          let url;
          try { url = new URL(src, location.href).href; } catch { return ""; }

          const alt = at("alt").replace(/([\[\]])/g, "\\$1");
          const title = at("title").replace(/\s+/g, " ").replace(/"/g, '\\"');
          return `![${alt}](${mdHref(url)}${title ? ` "${title}"` : ""})`;
        }
      });

      const markdown = service.turndown(parsed.content);

      const LIMIT = 60000;
      page.truncated = markdown.length > LIMIT;
      let body = page.truncated ? markdown.slice(0, LIMIT) : markdown;
      if (page.truncated) {
        // Avoid leaving a trailing high surrogate or an unclosed code fence.
        if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
        if (((body.match(/^```/gm) || []).length % 2) === 1) body += "\n```";
      }
      page.body = body;
      page.author ||= (parsed.byline || "").trim();
      page.siteName ||= parsed.siteName || "";
    }
  } catch { /* unreadable page: the metadata above still stands */ }

  if (proseLength(page.body) < 600) {
    try {
      const links = collectLinks();
      if (links) {
        page.kind = "index";
        page.body = links;
        page.truncated = false;
      }
    } catch { /* metadata above still stands */ }
  }

  return page;
}
