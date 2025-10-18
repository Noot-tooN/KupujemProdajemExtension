const TARGET_PREFIX = "https://www.kupujemprodajem.com/pretraga";
const latestTokenByTab = new Map();

function newToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function issueScrape(tabId, url) {
  if (!url.startsWith(TARGET_PREFIX)) return;

  const token = newToken();

  latestTokenByTab.set(tabId, token);

  // Tell the content script to begin its own "wait until ready then scrape" flow
  chrome.tabs
    .sendMessage(tabId, {
      type: "START_SCRAPE",
      url,
      token,
    })
    .catch((err) => {
      console.log(err);
    });
}

// INITIATORS (top-frame only)
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  issueScrape(tabId, url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(
  ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    issueScrape(tabId, url);
  }
);

chrome.webNavigation.onReferenceFragmentUpdated.addListener(
  ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    issueScrape(tabId, url);
  }
);

// Optional: also fire after full page load (classic navs)
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  issueScrape(tabId, url);
});

// FETCHERS
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "KP_STREAM") return;

  const tabId = port.sender?.tab?.id;

  port.onMessage.addListener((msg) => {
    if (msg?.type !== "FETCH") return;
    if (!Array.isArray(msg.payload.links)) return;

    const latest = latestTokenByTab.get(tabId);

    if (!latest || msg.token !== latest) return;

    streamResults(msg.payload.links, port, latest).catch((err) => {
      console.log(err);
    });
  });

  port.onMessage.addListener((msg) => {
    if (msg?.type !== "SET_CACHE") return;

    putInCache(msg.payload.url, msg.payload.data, 60 * 60 * 1000).catch(
      (err) => {
        console.log(err);
      }
    );
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (max) => Math.floor(Math.random() * (max + 1));

function postToPort(port, token, msgWithPayload) {
  if (!token) return; // tab navigated away

  port.postMessage({ ...msgWithPayload, token });
}

async function streamResults(
  links,
  port,
  token,
  { concurrency = 1, stutterMs = 500, jitterMs = 250 } = {}
) {
  if (!Array.isArray(links) || links.length === 0) return;

  // Stop gracefully if the port disconnects
  let alive = true;
  const onDisconnect = () => (alive = false);
  port.onDisconnect.addListener(onDisconnect);

  const tabId = port.sender?.tab?.id;
  const stillLatest = () => latestTokenByTab.get(tabId) === token;

  try {
    // ---- 1) Prime cache: check everything up front (in parallel) ----
    const cacheChecks = await Promise.all(
      links.map(async (item) => {
        try {
          const cached = await getFromCache(item.link);
          return { item, cached };
        } catch (e) {
          // Treat cache errors as a miss (we'll try network later)
          return { item, cached: null, cacheError: e };
        }
      })
    );

    if (!alive || !stillLatest()) return;

    // ---- 2) Stream all cache hits immediately (no delay) ----
    for (const { item, cached } of cacheChecks) {
      if (!alive || !stillLatest()) return;
      if (cached) {
        postToPort(port, token, {
          type: "CACHE_RESULT",
          payload: { response: { ...cached }, id: item.id },
        });
      }
    }

    if (!alive || !stillLatest()) return;

    // Figure out what still needs fetching
    const pending = cacheChecks
      .filter(({ cached }) => !cached)
      .map(({ item }) => item);

    if (pending.length === 0 || !alive) return;

    // ---- 3) Process only misses with stagger + concurrency ----
    let nextIndex = 0;

    const worker = async () => {
      while (alive && stillLatest()) {
        const myIndex = nextIndex++;
        if (myIndex >= pending.length) break;

        const item = pending[myIndex];

        try {
          // If your fetchOneWithCache() now has internal TTL logic, keep it.
          // Even though we pre-checked, calling it is fine and keeps logic centralized.
          postToPort(port, token, {
            type: "PROCESSING",
            payload: { id: item.id },
          });
          const res = await fetchOneWithCache(item.link);
          if (!alive || !stillLatest()) break;
          postToPort(port, token, {
            type: "RESULT",
            payload: { response: res, id: item.id },
          });
        } catch (err) {
          if (!alive || !stillLatest()) break;
          console.log(err);
          postToPort(port, token, {
            type: "RESULT_ERROR",
            error: { message: String((err && err.message) || err) },
          });
        }

        // stutter before the next pull (per worker)
        await sleep(stutterMs + randInt(jitterMs));
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      worker
    );
    await Promise.allSettled(workers);
  } finally {
    // ---- 4) Cleanup ----
    port.onDisconnect.removeListener(onDisconnect);
  }
}

async function fetchOneWithCache(url) {
  // Try cache
  const cached = await getFromCache(url);
  if (cached) return { ...cached, cached: true };

  // Network fetch
  const res = await fetchOne(url);

  return res;
}

async function fetchOne(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();

  if (!res.ok) {
    console.log("NOT OK!!!");
    console.log(res);
  }

  return { url, ok: res.ok, status: res.status, html };
}

const CACHE_PREFIX = "fetchCache:";

function cacheKeyFor(url) {
  return `${CACHE_PREFIX}${url}`;
}

async function getFromCache(url) {
  const key = cacheKeyFor(url);
  const obj = await chrome.storage.local.get(key);
  const entry = obj[key];
  if (!entry) return null;

  // drop expired entries
  if (Date.now() >= entry.expiresAt) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.value; // { url, ok, status, html }
}

async function putInCache(url, value, ttlMs) {
  const key = cacheKeyFor(url);
  const entry = {
    value, // { url, ok, status, html }
    expiresAt: Date.now() + ttlMs, // absolute expiry
  };
  await chrome.storage.local.set({ [key]: entry });
}
