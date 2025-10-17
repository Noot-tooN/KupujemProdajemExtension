// prove we can talk to background
chrome.runtime.sendMessage({ type: "PING" }, (resp) => {
  if (chrome.runtime.lastError) {
    console.warn("[CS] PING error:", chrome.runtime.lastError.message);
  } else {
    console.log("[CS] PING ->", resp); // <-- expect {pong:true}
  }
});

// Option A: run when background pings us on URL changes
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "RUN_SCRAPE") {
    console.log("[CS] RUN_SCRAPE for", location.href);
    runScrape();
  }
});

// Also run once when the script loads (first page open)
setTimeout(runScrape, 300);

function runScrape() {
  if (!location.href.startsWith("https://www.kupujemprodajem.com/pretraga"))
    return;

  const urls = getAdDetailLinks();
  if (!urls.length) return;

  console.log("[CS] Sending FETCH_LINKS for", urls.length, "urls");
  chrome.runtime.sendMessage(
    { type: "FETCH_LINKS", urls },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[CS] FETCH_LINKS error:",
          chrome.runtime.lastError.message
        );
        return;
      }

      // Extract info from HTML
      const out = resp.results.map(({ url, html }) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const username =
          doc
            .querySelector("[class^='UserSummary_userName_']")
            ?.textContent?.trim() || "";

        const likes =
          +(
            doc.querySelector("[class^='ReviewThumbButtons_positive']")
              ?.textContent || ""
          ).replace(/\D+/g, "") || 0;

        const dislikes =
          +(
            doc.querySelector("[class^='ReviewThumbButtons_negative']")
              ?.textContent || ""
          ).replace(/\D+/g, "") || 0;

        return { url, username, likes, dislikes };
      });

      // TODO: update DOM
      for (const item of out) {
        const linkObj = [...document.querySelectorAll("a[href]")].find((el) => {
          const u = new URL(
            el.getAttribute("href"),
            "https://www.kupujemprodajem.com"
          );
          return u.href === item.url;
        });

        const parentCtx = closestClassStartsWith(linkObj, "AdItem_adHolder");
        const adInfo = parentCtx.querySelector(
          "[class^='AdItem_viewAndFavorite']"
        );

        createUsernameDiv(adInfo, item);
        createLikesDiv(adInfo, item);
        createDislikesDiv(adInfo, item);
      }
    }
  );
}

function createUsernameDiv(target, data) {
  const div = document.createElement("div");
  div.textContent = `${data.username}`;
  target.append(div);
}

function createLikesDiv(target, data) {
  const div = document.createElement("div");
  div.textContent = `${data.likes}`;
  div.style.color = 'green';
  target.append(div);
}

function createDislikesDiv(target, data) {
  const div = document.createElement("div");
  div.textContent = `${data.dislikes}`;
  div.style.color = 'red';
  target.append(div);
}

function closestClassStartsWith(el, prefix) {
  for (let n = el; n; n = n.parentElement) {
    if ([...n.classList].some((c) => c.startsWith(prefix))) return n;
  }
  return null;
}

// Minimal link scraper (content only!)
function getAdDetailLinks() {
  return [...document.querySelectorAll("[class]")]
    .filter((el) =>
      [...el.classList].some((c) => c.startsWith("AdItem_adHolder"))
    )
    .map((el) => el.querySelector("a[href]"))
    .filter(Boolean)
    .map((a) => new URL(a.getAttribute("href"), location.href).href);
}
