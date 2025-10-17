console.log("[BG] service worker loaded"); // <-- you should see this in SW console after Reload

chrome.runtime.onInstalled.addListener(() => {
  console.log("[BG] onInstalled");
});

// URL-change notifier (Option A)
const TARGET_PREFIX = "https://www.kupujemprodajem.com/pretraga";
const lastRunByTab = new Map();

function shouldRun(url) { return url.startsWith(TARGET_PREFIX); }
function maybeNotify(tabId, url) {
  if (!shouldRun(url)) return;
  if (lastRunByTab.get(tabId) === url) return;
  lastRunByTab.set(tabId, url);
  console.log("[BG] notifying tab to RUN_SCRAPE for", url);
  chrome.tabs.sendMessage(tabId, { type: "RUN_SCRAPE", url }).catch(() => {});
}
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  maybeNotify(tabId, url);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  maybeNotify(tabId, url);
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  maybeNotify(tabId, url);
});
chrome.tabs.onRemoved.addListener(tabId => lastRunByTab.delete(tabId));

// --- Messaging diag + fetch handler ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[BG] onMessage:", msg?.type); // <-- you should see this when content sends
  if (msg?.type === "PING") {
    sendResponse({ pong: true });
    return; // sync reply; no need to return true
  }
  if (msg?.type === "FETCH_LINKS" && Array.isArray(msg.urls)) {
    console.log("[BG] FETCH_LINKS count=", msg.urls.length);
    fetchAll(msg.urls, 6).then(results => sendResponse({ results }));
    return true; // keep port open for async reply
  }
});

async function fetchAll(urls, limit) {
  const out = []; const q = urls.slice(); const running = new Set();
  const pump = () => {
    while (running.size < limit && q.length) {
      const url = q.shift();
      const p = fetchOne(url)
        .then(r => out.push(r))
        .catch(e => out.push({ url, ok:false, error:String(e) }))
        .finally(() => { running.delete(p); pump(); });
      running.add(p);
    }
  };
  return new Promise(resolve => {
    const tick = setInterval(() => {
      pump();
      if (!q.length && !running.size) { clearInterval(tick); resolve(out); }
    }, 20);
  });
}

async function fetchOne(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();

  // const doc = new DOMParser().parseFromString(html, 'text/html');
  // console.log(doc.querySelectorAll("[class]"))

  // NOTE: keep parsing minimal until messaging works
  return { url, ok: res.ok, status: res.status, html };
}
