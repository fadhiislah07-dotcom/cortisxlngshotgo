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

  // Column header text to look for in each tab (case-insensitive). These
  // must match the header row text used in your sheet.
  COLUMNS: {
    tag: "TAG",
    username: "USERNAME",
    item: "ITEM",
    status: "STATUS",
  },
};

/* ============================================================================
   IMPORTANT — before this works, your Google Sheet must be shared as
   "Anyone with the link" → "Viewer" (Share button, top right of the sheet).
   ============================================================================ */

let ALL_ORDERS = [];
let DATA_READY = false;

const $ = (sel) => document.querySelector(sel);

const searchForm = $("#searchForm");
const searchInput = $("#searchInput");
const searchStatus = $("#searchStatus");
const resultsSec = $("#resultsSec");
const emptyState = $("#emptyState");
const dashboardEl = $("#dashboard");
const orderListEl = $("#orderList");

/* ---------------------------------------------------------------------------
   Fetch + parse
--------------------------------------------------------------------------- */

function stripInvisible(str) {
  return String(str ?? "")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .trim();
}

function normalizeUsername(raw) {
  return stripInvisible(raw).replace(/^@+/, "").toLowerCase();
}

async function fetchTab(tab) {
  const url =
    `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:json&headers=0&gid=${encodeURIComponent(tab.gid)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load tab "${tab.name}" (HTTP ${res.status})`);
  const text = await res.text();

  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

  const rows = json.table.rows || [];
  const wanted = CONFIG.COLUMNS;

  // find the header row by scanning the first ~10 rows for cells that match
  // TAG / USERNAME / STATUS — makes this resilient to blank title rows.
  let headerRowIndex = -1;
  let colIndex = {};

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i].c || []).map((c) => stripInvisible(c?.v).toUpperCase());
    const found = {};
    Object.entries(wanted).forEach(([key, label]) => {
      const idx = cells.findIndex((c) => c === label.toUpperCase());
      if (idx !== -1) found[key] = idx;
    });
    if (found.tag !== undefined && found.username !== undefined && found.status !== undefined) {
      headerRowIndex = i;
      colIndex = found;
      break;
    }
  }

  if (headerRowIndex === -1) {
    console.warn(
      `Header row not found in tab "${tab.name}" (gid ${tab.gid}) — skipping this tab. ` +
      `Check that it has a row with TAG / USERNAME / STATUS headers.`
    );
    return [];
  }

  const out = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const c = rows[i].c || [];
    const get = (key) => stripInvisible(c[colIndex[key]]?.v ?? "");

    const tag = get("tag");
    const username = get("username");
    const item = colIndex.item !== undefined ? get("item") : "";
    const status = get("status");

    if (!tag && !username) continue; // skip blank rows

    out.push({
      tab: tab.name,
      tag,
      username,
      usernameKey: normalizeUsername(username),
      item,
      status,
      statusKey: normalizeStatus(status),
    });
  }

  return out;
}

async function loadAllData() {
  searchStatus.textContent = "Loading masterlist…";
  try {
    const results = await Promise.all(CONFIG.SHEET_TABS.map(fetchTab));
    ALL_ORDERS = results.flat();
    DATA_READY = true;

    // Diagnostics — safe to leave in, only shows when something looks wrong.
    console.log(`Loaded ${ALL_ORDERS.length} order rows from ${CONFIG.SHEET_TABS.length} tab(s).`);

    if (ALL_ORDERS.length === 0) {
      searchStatus.textContent =
        "The masterlist loaded, but no order rows were found. Check that your sheet is shared as " +
        "\u201CAnyone with the link \u2013 Viewer,\u201D and that SHEET_TABS in script.js has the right gid(s) " +
        "and that the header row has exact column names TAG / USERNAME / STATUS.";
    } else {
      searchStatus.textContent = "";
    }
  } catch (err) {
    console.error(err);
    searchStatus.textContent =
      "Couldn't load the masterlist right now. Make sure the Google Sheet is shared as \u201CAnyone with the link \u2013 Viewer.\u201D";
  }
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
  // fallback: loose contains-match, in case of stray spacing/punctuation
  if (s.includes("SECURED")) return "secured";
  if (s.includes("OTW") || s.includes("ARRIVED AT WH")) return "transit";
  if (s.includes("ADMIN")) return "admin";
  if (s.includes("POSTED")) return "posted";
  return "other";
}

const STATUS_LABEL = {
  secured: "Secured",
  transit: "In Transit",
  admin: "Admin House",
  posted: "Posted Out",
  other: "Other",
};

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */

function renderDashboard(orders) {
  const counts = { secured: 0, transit: 0, admin: 0, posted: 0, other: 0 };
  orders.forEach((o) => counts[o.statusKey]++);

  const cards = [
    { key: "total", label: "Total Orders", value: orders.length, cls: "statCard--total" },
    { key: "secured", label: "Secured", value: counts.secured, cls: "statCard--secured" },
    { key: "transit", label: "In Transit", value: counts.transit, cls: "statCard--transit" },
    { key: "admin", label: "Admin House", value: counts.admin, cls: "statCard--admin" },
    { key: "posted", label: "Posted Out", value: counts.posted, cls: "statCard--posted" },
  ];
  if (counts.other > 0) {
    cards.push({ key: "other", label: "Other", value: counts.other, cls: "statCard--other" });
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
  orderListEl.innerHTML = orders
    .map(
      (o) => `
      <article class="orderCard">
        <span class="orderCard__tag">${escapeHTML(o.tag || "\u2014")}</span>
        <div class="orderCard__main">
          <div class="orderCard__item">${escapeHTML(o.item || "\u2014")}</div>
          <div class="orderCard__meta">@${escapeHTML(o.username.replace(/^@+/, ""))}</div>
        </div>
        <span class="stamp stamp--${o.statusKey}">${escapeHTML(o.status || "Unknown")}</span>
      </article>`
    )
    .join("");
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  renderDashboard(matches);
  renderOrders(matches);
  emptyState.hidden = true;
  resultsSec.hidden = false;
  searchStatus.textContent = `Found ${matches.length} order${matches.length === 1 ? "" : "s"} for @${query}.`;
}

searchForm.addEventListener("submit", handleSearch);

/* ---------------------------------------------------------------------------
   Init
--------------------------------------------------------------------------- */
loadAllData();
