/* ============================================================================
   CONFIG — edit this block to point the site at your masterlist.
   ============================================================================ */
const CONFIG = {
  // The long ID in your Google Sheet URL:
  // https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
  SHEET_ID: "1z2CJDXZojsE-FU6LFCoWYKR93-djhHFyziaLwFsTi2w",

  // One entry per TAB you want searchable (e.g. KR GO, CN GO, INA GO, MY GO + BULK).
  // Find each tab's "gid" by clicking the tab in Google Sheets and reading the
  // number after "gid=" in the browser's address bar. gid=0 is usually the
  // first/leftmost tab. Add or remove lines as needed — order doesn't matter.
  SHEET_TABS: [
    { name: "KR GO", gid: "0" },
    { name: "CN GO", gid: "688871900" },
    { name: "INA GO", gid: "373988392" },
    { name: "MY GO + BULK", gid: "773812417" },
  ],

  // Column header text to look for in each tab (case-insensitive, punctuation
  // and extra spacing ignored). tag/username/status are required — if a tab
  // is missing any of those three, that tab is skipped. item/qty/ems/remark
  // are optional. Each entry can be one label or an array of accepted
  // variants — e.g. qty accepts both "QTY" and "QUANTITY".
  COLUMNS: {
    tag: "TAG",
    username: "USERNAME",
    item: "ITEM",
    status: "STATUS",
    qty: ["QTY", "QUANTITY", "QTY/PCS", "QTY(PCS)"],
    ems: "EMS",
    remark: "REMARK",
  },
};

/* ============================================================================
   IMPORTANT — before this works, your Google Sheet must be shared as
   "Anyone with the link" → "Viewer" (Share button, top right of the sheet).
   ============================================================================ */

let ALL_ORDERS = [];
let DATA_READY = false;
let TAB_REPORTS = []; // diagnostics shown in the "Sync details" panel

const $ = (sel) => document.querySelector(sel);

const searchForm = $("#searchForm");
const searchInput = $("#searchInput");
const searchStatus = $("#searchStatus");
const resultsSec = $("#resultsSec");
const emptyState = $("#emptyState");
const announcementsEl = $("#announcements");
const dashboardEl = $("#dashboard");
const orderListEl = $("#orderList");
const filterRow = $("#filterRow");
const themeToggle = $("#themeToggle");
const syncToggle = $("#syncToggle");
const syncPanel = $("#syncPanel");
const recentSearchesEl = $("#recentSearches");
const syncFooterStatus = $("#syncFooterStatus");
const refreshDataBtn = $("#refreshDataBtn");

/* ---------------------------------------------------------------------------
   Helpers
--------------------------------------------------------------------------- */

function stripInvisible(str) {
  return String(str ?? "")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .trim();
}

function normalizeUsername(raw) {
  return stripInvisible(raw).replace(/^@+/, "").toLowerCase();
}

// Loosely normalize header text for matching: uppercase, collapse whitespace,
// drop anything that isn't a letter or digit. This means "QTY", "Qty ",
// "Qty/Pcs", "QTY:" etc. all match a target of "QTY".
function normalizeHeader(raw) {
  return stripInvisible(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function colLetter(idx) {
  let n = idx;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* ---------------------------------------------------------------------------
   Fetch + parse one tab
--------------------------------------------------------------------------- */

async function fetchTab(tab) {
  const report = { name: tab.name, gid: tab.gid, ok: false, rowCount: 0, columns: {}, message: "" };

  let json;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:json&headers=0&gid=${encodeURIComponent(tab.gid)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    report.message = `Could not load this tab (${err.message}). Check the gid and that the sheet is shared as "Anyone with the link – Viewer."`;
    TAB_REPORTS.push(report);
    return [];
  }

  const rows = json.table.rows || [];
  const wanted = CONFIG.COLUMNS;
  // Normalize each column's accepted label(s) into an array of normalized strings.
  const wantedNorm = Object.fromEntries(
    Object.entries(wanted).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(normalizeHeader)])
  );

  // Scan every row for the one that contains our required header labels.
  // (Sheets often have a title row and a blank row above the real headers,
  // so we can't just assume row 1 or row 3 — we search for it.)
  let headerRowIndex = -1;
  let colIndex = {};

  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i].c || []).map((c) => normalizeHeader(c?.v));
    const found = {};
    Object.entries(wantedNorm).forEach(([key, labels]) => {
      let idx = cells.findIndex((c) => labels.includes(c));
      if (idx === -1) idx = cells.findIndex((c) => c && labels.some((label) => c.includes(label)));
      if (idx !== -1) found[key] = idx;
    });
    if (found.tag !== undefined && found.username !== undefined && found.status !== undefined) {
      headerRowIndex = i;
      colIndex = found;
      break;
    }
  }

  // Fallback for QTY: an all-numeric column (like QTY, e.g. 1, 2, 1, 1...)
  // gets its data-type auto-detected as "number" by Google's API, which then
  // silently nulls out the one non-numeric cell in that column — the header
  // word "QTY" itself — before it ever reaches this site. So if we couldn't
  // read the QTY header as text, fall back to "the column right after ITEM",
  // matching this sheet's consistent TAG/USERNAME/ITEM/QTY/... layout.
  if (headerRowIndex !== -1 && colIndex.qty === undefined && colIndex.item !== undefined) {
    const guess = colIndex.item + 1;
    const alreadyUsed = Object.values(colIndex).includes(guess);
    if (!alreadyUsed) {
      colIndex.qty = guess;
      colIndex._qtyGuessed = true;
    }
  }

  if (headerRowIndex === -1) {
    report.message = 'No row with TAG / USERNAME / STATUS headers was found in this tab.';
    TAB_REPORTS.push(report);
    return [];
  }

  report.columns = Object.fromEntries(
    Object.entries(colIndex)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, idx]) => [key, colLetter(idx) + (key === "qty" && colIndex._qtyGuessed ? " (guessed)" : "")])
  );

  const out = [];
  let lastTag = "";
  let lastItem = "";
  let lastStatus = "";

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const c = rows[i].c || [];
    const get = (key) => (colIndex[key] !== undefined ? stripInvisible(c[colIndex[key]]?.v ?? "") : "");

    let tag = get("tag");
    const username = get("username");
    let item = get("item");
    let status = get("status");
    const qtyRaw = get("qty");
    const ems = get("ems");
    const remark = get("remark");
    const qtyDisplay = colIndex.qty !== undefined ? qtyRaw || "1" : ""; // blank QTY cell means "1"

    if (!tag && !username && !item && !status) continue; // fully blank row

    // Forward-fill merged cells: if a batch's TAG/ITEM/STATUS is merged
    // across several rows, only the first row carries the value and the
    // rest come back blank from the sheet — carry the last seen value
    // forward so every row still shows the right info.
    if (tag) lastTag = tag; else tag = lastTag;
    if (item) lastItem = item; else item = lastItem;
    if (status) lastStatus = status; else status = lastStatus;

    if (!username) continue; // no customer to attach this row to

    out.push({
      tab: tab.name,
      tag,
      username,
      usernameKey: normalizeUsername(username),
      item,
      status,
      statusKey: normalizeStatus(status),
      qty: qtyDisplay,
      ems,
      remark,
    });
  }

  report.ok = true;
  report.rowCount = out.length;
  TAB_REPORTS.push(report);
  return out;
}

async function loadAllData() {
  searchStatus.textContent = "Loading masterlist…";
  if (syncFooterStatus) syncFooterStatus.textContent = "Syncing with masterlist\u2026";
  TAB_REPORTS = [];

  const results = await Promise.all(CONFIG.SHEET_TABS.map(fetchTab));
  ALL_ORDERS = results.flat();
  DATA_READY = true;

  renderSyncPanel();

  if (ALL_ORDERS.length === 0) {
    searchStatus.textContent =
      "The masterlist loaded, but no order rows were found — open \u201CSync details\u201D below to see why.";
  } else {
    searchStatus.textContent = "";
  }

  if (syncFooterStatus) {
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    syncFooterStatus.textContent = `Synced with masterlist \u00b7 ${time} \u00b7 ${ALL_ORDERS.length} order lines loaded`;
  }
}

function renderSyncPanel() {
  syncPanel.innerHTML = TAB_REPORTS.map((r) => {
    if (!r.ok) {
      return `<div class="syncRow syncRow--bad">
        <strong>${escapeHTML(r.name)}</strong> (gid ${escapeHTML(r.gid)}) — ${escapeHTML(r.message)}
      </div>`;
    }
    const cols = ["tag", "username", "item", "status", "qty", "ems", "remark"]
      .map((k) => `${k}: ${r.columns[k] ? "col " + r.columns[k] : "\u2014 not found"}`)
      .join(" · ");
    return `<div class="syncRow syncRow--ok">
      <strong>${escapeHTML(r.name)}</strong> — ${r.rowCount} order rows loaded<br>
      <span class="syncRow__cols">${escapeHTML(cols)}</span>
    </div>`;
  }).join("");
}

if (syncToggle) {
  syncToggle.addEventListener("click", () => {
  const isHidden = syncPanel.hasAttribute("hidden");
  if (isHidden) {
    syncPanel.removeAttribute("hidden");
    syncToggle.textContent = "Sync details \u25b4";
  } else {
    syncPanel.setAttribute("hidden", "");
    syncToggle.textContent = "Sync details \u25be";
  }
  });
}

/* ---------------------------------------------------------------------------
   Status classification
--------------------------------------------------------------------------- */

function normalizeStatus(raw) {
  const s = stripInvisible(raw).toUpperCase();
  if (s === "SECURED") return "secured";
  if (s === "OTW TO WH" || s === "ARRIVED AT WH" || s === "OTW TO MY") return "transit";
  if (s === "ADMIN HOUSE") return "admin";
  if (s === "POSTED OUT") return "posted";
  if (!s) return "other";
  if (s.includes("SECURED")) return "secured";
  if (s.includes("OTW") || s.includes("ARRIVED AT WH")) return "transit";
  if (s.includes("ADMIN")) return "admin";
  if (s.includes("POSTED")) return "posted";
  return "other";
}

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */

function renderDashboard(orders) {
  const counts = { secured: 0, transit: 0, admin: 0, posted: 0, other: 0 };
  orders.forEach((o) => counts[o.statusKey]++);

  const cards = [
    { label: "Total Orders", value: orders.length, cls: "statCard--total" },
    { label: "Secured", value: counts.secured, cls: "statCard--secured" },
    { label: "In Transit", value: counts.transit, cls: "statCard--transit" },
    { label: "Admin House", value: counts.admin, cls: "statCard--admin" },
    { label: "Posted Out", value: counts.posted, cls: "statCard--posted" },
  ];
  if (counts.other > 0) {
    cards.push({ label: "Other", value: counts.other, cls: "statCard--other" });
  }

  dashboardEl.innerHTML = cards
    .map(
      (c) => `
      <div class="statCard ${c.cls}">
        <div class="statCard__num">${c.value}</div>
        <div class="statCard__label">${c.label}</div>
      </div>`
    )
    .join("");
}

function renderOrders(orders) {
  if (orders.length === 0) {
    orderListEl.innerHTML = `<p class="orderList__empty">No orders match this filter.</p>`;
    return;
  }

  orderListEl.innerHTML = orders
    .map((o) => {
      const pills = [];
      if (o.qty) pills.push(`<span class="pill">Qty: ${escapeHTML(o.qty)}</span>`);
      if (o.ems) pills.push(`<span class="pill pill--ems ${emsClass(o.ems)}">EMS: ${escapeHTML(o.ems)}</span>`);

      return `
      <article class="orderCard">
        <span class="orderCard__tag">${escapeHTML(o.tag || "\u2014")}</span>
        <div class="orderCard__main">
          <div class="orderCard__item">${escapeHTML(o.item || "\u2014")}</div>
          <div class="orderCard__meta">@${escapeHTML(o.username.replace(/^@+/, ""))}</div>
          ${pills.length ? `<div class="orderCard__pills">${pills.join("")}</div>` : ""}
          ${o.remark ? `<div class="orderCard__remark">📝 ${escapeHTML(o.remark)}</div>` : ""}
        </div>
        <span class="stamp stamp--${o.statusKey}">${escapeHTML(o.status || "Unknown")}</span>
      </article>`;
    })
    .join("");
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function emsClass(raw) {
  const s = stripInvisible(raw).toUpperCase();
  if (s.includes("PENDING")) return "pill--pending";
  if (s.includes("PAID")) return "pill--paid";
  return "";
}

/* ---------------------------------------------------------------------------
   Status filter
--------------------------------------------------------------------------- */

let CURRENT_MATCHES = [];

function applyFilter(filterKey) {
  filterRow.querySelectorAll(".filterChip").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.filter === filterKey);
  });
  const filtered =
    filterKey === "all" ? CURRENT_MATCHES : CURRENT_MATCHES.filter((o) => o.statusKey === filterKey);
  renderOrders(filtered);
}

if (filterRow) {
  filterRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".filterChip");
    if (!btn) return;
    applyFilter(btn.dataset.filter);
  });
}

/* ---------------------------------------------------------------------------
   Recent searches (remembered on this device via localStorage)
--------------------------------------------------------------------------- */

const RECENT_KEY = "recentSearches";
const RECENT_MAX = 5;

function loadRecentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(username) {
  let list = loadRecentSearches();
  list = list.filter((u) => u !== username);
  list.unshift(username);
  list = list.slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore storage errors (e.g. private browsing) */
  }
  renderRecentSearches();
}

function renderRecentSearches() {
  if (!recentSearchesEl) return;
  const list = loadRecentSearches();
  if (list.length === 0) {
    recentSearchesEl.innerHTML = "";
    return;
  }
  const chips = list
    .map((u) => `<button type="button" class="recentChip" data-username="${escapeHTML(u)}">@${escapeHTML(u)}</button>`)
    .join("");
  recentSearchesEl.innerHTML =
    `<span class="recentSearches__label">Recent:</span>${chips}` +
    `<button type="button" class="recentChip recentChip--clear" id="clearRecent">Clear</button>`;
}

if (recentSearchesEl) {
  recentSearchesEl.addEventListener("click", (e) => {
    if (e.target.id === "clearRecent") {
      try {
        localStorage.removeItem(RECENT_KEY);
      } catch {
        /* ignore */
      }
      renderRecentSearches();
      return;
    }
    const btn = e.target.closest(".recentChip");
    if (!btn || !btn.dataset.username) return;
    searchInput.value = btn.dataset.username;
    searchForm.requestSubmit();
  });
}

/* ---------------------------------------------------------------------------
   Search
--------------------------------------------------------------------------- */

async function handleSearch(e) {
  e.preventDefault();
  const query = normalizeUsername(searchInput.value);
  if (!query) return;

  if (!DATA_READY) {
    searchStatus.textContent = "Still loading the masterlist — try again in a second.";
    return;
  }

  if (announcementsEl) announcementsEl.classList.add("is-collapsed");

  saveRecentSearch(query);

  const matches = ALL_ORDERS.filter((o) => o.usernameKey === query);

  if (matches.length === 0) {
    resultsSec.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector(".emptyState__ticketTop").textContent = "NO ORDERS FOUND";
    emptyState.querySelector("p").textContent =
      `We couldn't find any orders under @${escapeHTML(query)}. Double-check your Telegram username and try again.`;
    searchStatus.textContent = "";
    return;
  }

  CURRENT_MATCHES = matches;
  renderDashboard(matches);
  applyFilter("all");
  emptyState.hidden = true;
  resultsSec.hidden = false;
  searchStatus.textContent = `Found ${matches.length} order${matches.length === 1 ? "" : "s"} for @${query}.`;
}

if (searchForm) {
  searchForm.addEventListener("submit", handleSearch);
  searchInput.addEventListener("input", () => {
    if (!searchInput.value.trim() && announcementsEl) {
      announcementsEl.classList.remove("is-collapsed");
    }
  });
}

/* ---------------------------------------------------------------------------
   Dark mode
--------------------------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  if (themeToggle) themeToggle.textContent = theme === "dark" ? "\u2600\ufe0f" : "\ud83c\udf19";
}

const savedTheme =
  localStorage.getItem("theme") ||
  (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
applyTheme(savedTheme);

if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });
}

/* ---------------------------------------------------------------------------
   Init
--------------------------------------------------------------------------- */
if (searchForm) {
  loadAllData();
  renderRecentSearches();
}

if (refreshDataBtn) {
  refreshDataBtn.addEventListener("click", async () => {
    refreshDataBtn.disabled = true;
    refreshDataBtn.classList.add("is-spinning");
    await loadAllData();
    if (searchInput.value.trim()) {
      searchForm.requestSubmit();
    }
    refreshDataBtn.disabled = false;
    refreshDataBtn.classList.remove("is-spinning");
  });
}

/* ---------------------------------------------------------------------------
   Scroll-triggered video playback (Events & Updates page)
   Embedded videos (iframes) are lazy-loaded and start muted+autoplaying the
   moment they scroll into view — browsers block autoplay-with-sound
   entirely, so this matches how Instagram/Twitter feeds behave: the video
   plays automatically, and the player's own controls let people tap to
   unmute for sound. Runs on any page that has one of these, no guard needed.
--------------------------------------------------------------------------- */
(function setupScrollVideos() {
  const lazyIframes = document.querySelectorAll(".updateCard__videoWrap iframe[data-src]");
  const nativeVideos = document.querySelectorAll("video.updateCard__video");
  if (lazyIframes.length === 0 && nativeVideos.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const el = entry.target;
        if (entry.isIntersecting) {
          if (el.tagName === "IFRAME" && el.dataset.src && !el.src) {
            const sep = el.dataset.src.includes("?") ? "&" : "?";
            el.src = `${el.dataset.src}${sep}autoplay=1&muted=1`;
          }
          if (el.tagName === "VIDEO") {
            el.muted = true;
            el.playsInline = true;
            el.play().catch(() => {
              /* autoplay can still be blocked in some browsers — that's fine,
                 the visible controls let the person press play manually */
            });
          }
        } else if (el.tagName === "VIDEO") {
          el.pause();
        }
      });
    },
    { threshold: 0.6 }
  );

  lazyIframes.forEach((el) => observer.observe(el));
  nativeVideos.forEach((el) => observer.observe(el));
})();
