const port = chrome.runtime.connect({ name: "KP_STREAM" });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "START_SCRAPE") return;

  initialize(msg.token)
    .then(() => {})
    .catch((err) => {
      console.log(err);
    });
});

function createUsernameDiv(target, username) {
  const div = document.createElement("div");
  div.textContent = `${username}`;
  target.append(div);
}

function createLikesDiv(target, likes) {
  const div = document.createElement("div");
  div.textContent = `${likes}`;
  div.style.color = "green";
  target.append(div);
}

function createDislikesDiv(target, dislikes) {
  const div = document.createElement("div");
  div.textContent = `${dislikes}`;
  div.style.color = "red";
  target.append(div);
}

function closestClassStartsWith(el, prefix) {
  for (let n = el; n; n = n.parentElement) {
    if ([...n.classList].some((c) => c.startsWith(prefix))) return n;
  }
  return null;
}

function getAdItems() {
  return [...document.querySelectorAll("[class^='AdItem_adHolder']")];
}

function getViewAndFavorite(el) {
  return el.querySelector("[class^='AdItem_viewAndFavorite']");
}

const idPrefix = "kpplaceholder";

function generatePlaceholder(el, id, token) {
  const div = document.createElement("div");
  div.id = id;
  div.classList = "placeholder";
  div.dataset.token = token;

  generatePlaceholderSpinner(div);

  el.append(div);
}

function generatePlaceholderSpinner(el) {
  const size = 32;
  const src =
    "https://raw.githubusercontent.com/SamHerbert/SVG-Loaders/master/svg-loaders/puff.svg";
  const color = "white";

  const spinner = document.createElement("span");
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "loading");
  spinner.className = "kp-loading-spinner"; // note: '=' not '=='

  // Size & color
  spinner.style.display = "inline-block";
  spinner.style.width = `${size}px`;
  spinner.style.height = `${size}px`;
  spinner.style.backgroundColor = color; // change this to paint the spinner

  // SVG as mask (works cross-origin)
  spinner.style.webkitMask = `url("${src}") no-repeat center / contain`;
  spinner.style.mask = `url("${src}") no-repeat center / contain`;

  el.append(spinner);
}

function createPlaceholders(items, token) {
  return items.map((it) => {
    const viewAndFavorite = getViewAndFavorite(it);

    if (viewAndFavorite == null) {
      return;
    }

    const uuid = crypto.randomUUID();

    const id = `${idPrefix}-${uuid}`;

    generatePlaceholder(viewAndFavorite, id, token);

    return {
      ad: it,
      id,
    };
  });
}

function extractLinks(items) {
  return items
    .map((it) => {
      link = it.ad?.querySelector("a[href]")?.href;

      return {
        link,
        id: it.id,
      };
    })
    .filter((it) => {
      return it.link != null;
    });
}

function getDataFromHTML(html) {
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

  return { username, likes, dislikes };
}

port.onMessage.addListener((msg) => {
  if (msg?.type !== "PROCESSING") return;
  // if (msg.token !== currentToken) return; // ← ignore stale

  const placeholder = document.querySelector(`#${msg.payload.id}`);

  if (placeholder == null) {
    return;
  }

  const spinner = placeholder.querySelector(".kp-loading-spinner");

  if (spinner == null) {
    return;
  }

  spinner.style.backgroundColor = "yellow";
});

port.onMessage.addListener((msg) => {
  if (msg?.type !== "CACHE_RESULT") return;
  // if (msg.token !== currentToken) return; // ← ignore stale

  const placeholder = document.querySelector(`#${msg.payload.id}`);

  if (placeholder == null) {
    return;
  }

  const spinner = placeholder.querySelector(".kp-loading-spinner");

  if (spinner == null) {
    return;
  }

  spinner.remove();

  createUsernameDiv(placeholder, msg.payload.response.username);
  createLikesDiv(placeholder, msg.payload.response.likes);
  createDislikesDiv(placeholder, msg.payload.response.dislikes);
});

port.onMessage.addListener((msg) => {
  if (msg?.type !== "RESULT_ERROR") return;

  console.log(msg);
});

// listen for messages from background
port.onMessage.addListener((msg) => {
  if (msg?.type !== "RESULT") return;
  // if (msg.token !== currentToken) return; // ← ignore stale

  const placeholder = document.querySelector(`#${msg.payload.id}`);

  if (placeholder == null) {
    return;
  }

  const spinner = placeholder.querySelector(".kp-loading-spinner");

  if (spinner == null) {
    return;
  }

  if (!msg?.payload?.response?.ok) {
    spinner.style.backgroundColor = "red";
    return;
  }

  const data = getDataFromHTML(msg.payload.response.html);

  port.postMessage({
    type: "SET_CACHE",
    payload: {
      url: msg.payload.response.url,
      data,
    },
  });

  spinner.remove();

  createUsernameDiv(placeholder, data.username);
  createLikesDiv(placeholder, data.likes);
  createDislikesDiv(placeholder, data.dislikes);
});

async function initialize(token) {
  if (!location.href.startsWith("https://www.kupujemprodajem.com/pretraga"))
    return;

  let items = null;
  let item = null;
  let ind = 0;
  while (item == null) {
    if (ind > 0) {
      await sleep(100);
    }

    items = getAdItems();

    if (items.length == 0) {
      ind++;
      continue;
    }

    const placeholder = items[0].querySelector(`[class='placeholder']`);
    if (placeholder != null) {
      ind++;
      continue;
    }

    item = items[0].querySelector(`[class^='AdItem_price']`);
    ind++;
  }

  const uninitItems = items.filter((el) => {
    const placeholder = el.querySelector(`[id^='${idPrefix}']`);
    return placeholder == null;
  });

  if (uninitItems.length == 0) {
    return;
  }

  const res = createPlaceholders(uninitItems, token);

  const links = extractLinks(res);

  port.postMessage({ type: "FETCH", payload: { links }, token: token });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
