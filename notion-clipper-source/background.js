import { signIn, signOut, accessToken, completeSignIn } from "./auth.js";
import { addHighlight, siteOf, pending as pendingHighlights, readHighlights, writeHighlights } from "./highlights.js";

if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined")
  globalThis.browser = globalThis.chrome;

// Origin strip lives in rules.json (DNR modifyHeaders) - webRequestBlocking
// is unavailable in Chrome MV3, so no listener here. Service workers are
// non-persistent: `pending` dedups within one lifetime only; the sign-in
// outcome persists via storage.local either way.

// The popup that sent this message is gone by the time the flow finishes, so
// the outcome goes to storage: the next popup open reads it.
let pending = null;

// Android sign-in finishes here. The tab update is also what wakes this event
// page if it was suspended while the user was on Notion's consent screen.
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url)
    completeSignIn(tabId, change.url).catch((e) => console.error("sign-in resume failed:", e));
});

function startSignIn() {
  pending ??= signIn()
    .then(() => ({ ok: true }))
    .catch(async (e) => {
      console.error("sign-in failed:", e);
      await browser.storage.local.set({ auth_error: e.message });
      return { ok: false, error: e.message };
    })
    .finally(() => { pending = null; });
  return pending;
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "signin":
      return startSignIn();
    case "signout":
      return signOut().then(() => ({ ok: true }));
    case "token":
      return accessToken()
        .then((token) => ({ ok: true, token }))
        .catch((e) => ({ ok: false, error: e.message }));
    // The popup drains the queue but the badge is this worker's, so it asks.
    case "repaint-badge":
      return paintBadge().then(() => ({ ok: true }));
  }
});

// ---------- highlight capture ----------

// Capture lives here, not in the popup, for the same reason sign-in does: the
// popup is destroyed the moment focus moves, and a context-menu click or a
// shortcut has to work with no popup open at all.

const MENU_ID = "slipclip-highlight";

// A menu survives a worker restart, but reloading during development would
// duplicate it, so start from empty every install.
browser.runtime.onInstalled.addListener(async () => {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: MENU_ID,
    title: "Save highlight to SlipClip",
    // Registered for selections only, so this path can never fire empty.
    contexts: ["selection"]
  });
});

// Capture has no UI, so the badge is the only feedback there is.
async function paintBadge() {
  const count = pendingHighlights(await readHighlights()).length;
  await browser.action.setBadgeBackgroundColor({ color: "#e8b32c" });
  await browser.action.setBadgeText({ text: count ? String(count) : "" });
}

// ponytail: a timer, which a worker suspended before it fires would drop - the
// badge then stays on "!" until the next capture. Swap for an alarm if that
// ever misleads.
async function flashEmpty() {
  await browser.action.setBadgeBackgroundColor({ color: "#c0392b" });
  await browser.action.setBadgeText({ text: "!" });
  setTimeout(() => paintBadge().catch(() => {}), 1500);
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
  // The click data carries both of these, so this path needs no activeTab grant
  // and no injection - which is why it still works where the browser blocks
  // extensions from running.
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

// A freshly started worker has no badge until something repaints it.
paintBadge().catch(() => {});
