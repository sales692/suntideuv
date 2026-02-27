console.log("APP JS VERSION 6 LOADED");

const DEFAULT = { name: "Brisbane", lat: -27.4698, lon: 153.0251 };

const el = (id) => document.getElementById(id);

// UI
const loading = el("loading");
const pillStatus = el("pillStatus");
const pillPlace = el("pillPlace");
const pillDate = el("pillDate");

const sunriseVal = el("sunriseVal");
const sunsetVal = el("sunsetVal");
const uvVal = el("uvVal");
const uvHint = el("uvHint");
const moonVal = el("moonVal");
const moonHint = el("moonHint");

const sunriseVal1 = el("sunriseVal1");
const sunsetVal1 = el("sunsetVal1");
const uvVal1 = el("uvVal1");
const moonVal1 = el("moonVal1");

const nextTide = el("nextTide");
const nextTideHint = el("nextTideHint");
const tideStation = el("tideStation");
const tidesList = el("tidesList");
const tidesEmpty = el("tidesEmpty");

// Buttons
el("btnLocate")?.addEventListener("click", () => locateAndLoad());
el("btnBrisbane")?.addEventListener("click", () =>
  loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name)
);

init();

function showLoading(on) {
  if (!loading) return;
  loading.classList.toggle("hidden", !on);
}

function setStatus(text) {
  if (pillStatus) pillStatus.textContent = text;
}

async function init() {
  setStatus("Getting location…");
  await locateAndLoad({ quietFail: true });
}

async function locateAndLoad({ quietFail = false } = {}) {
  if (!navigator.geolocation) {
    if (!quietFail) alert("Geolocation not supported. Using Brisbane.");
    return loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name);
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = round(pos.coords.latitude, 4);
      const lon = round(pos.coords.longitude, 4);
      loadFor(lat, lon, "Your location");
    },
    () => {
      if (!quietFail) alert("Location blocked. Using Brisbane.");
      loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name);
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
  );
}

async function loadFor(lat, lon, label) {
  showLoading(true);
  setStatus("Loading…");
  if (pillPlace) pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

  try {
    // 1) Load core data (NO tides)
    const [today, tomorrow] = await Promise.all([
      fetchSummaryWithTimeout(lat, lon, 0, { tides: false }),
      fetchSummaryWithTimeout(lat, lon, 1, { tides: false }),
    ]);

    renderToday(today);
    renderTomorrow(tomorrow);

    setStatus("Updated");

    // 2) Load tides AFTER the page has rendered (prevents “infinite loading” feel)
    setTidesLoadingState(true);
    const todayWithTides = await fetchSummaryWithTimeout(lat, lon, 0, { tides: true });

    // If quota exceeded (or any tide error), show friendly message
    if (todayWithTides?.tides_status !== "ok" || !Array.isArray(todayWithTides?.tides) || todayWithTides.tides.length === 0) {
      renderTides(todayWithTides); // will show “no tide data returned…”
    } else {
      renderTides(todayWithTides);
    }

  } catch (err) {
    console.error(err);
    setStatus("Error");
    alert("Could not load data. Please try again.");
  } finally {
    setTidesLoadingState(false);
    showLoading(false);
  }
}

// ---------- Data fetching ----------
async function fetchSummaryWithTimeout(lat, lon, day, opts = {}) {
  const wantTides = Boolean(opts.tides);
  const msTimeout = opts.msTimeout ?? 8000;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), msTimeout);

  try {
    const url =
      `/api/summary?lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lon)}` +
      `&day=${encodeURIComponent(day)}` +
      (wantTides ? `&tides=1` : ``) +
      `&v=6`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Render ----------
function renderToday(data) {
  if (pillDate) pillDate.textContent = `Date: ${prettyDate(data?.date)}`;

  if (sunriseVal) sunriseVal.textContent = time(data?.sun?.sunrise);
  if (sunsetVal) sunsetVal.textContent = time(data?.sun?.sunset);

  const uv = data?.uv?.max;
  if (uvVal) uvVal.textContent = isNum(uv) ? uv.toFixed(1) : "—";
  if (uvHint) uvHint.textContent = isNum(uv) ? uvLabel(uv) : "—";

  if (moonVal) moonVal.textContent = data?.moon?.phase ?? "—";
  if (moonHint)
    moonHint.textContent = isNum(data?.moon?.illuminationPct)
      ? `${data.moon.illuminationPct}% illuminated`
      : "—";

  // reset tides to a safe empty state
  renderTides({ tides: [], tideStation: null, tides_status: "skipped" });
}

function renderTomorrow(data) {
  if (sunriseVal1) sunriseVal1.textContent = time(data?.sun?.sunrise);
  if (sunsetVal1) sunsetVal1.textContent = time(data?.sun?.sunset);

  const uv = data?.uv?.max;
  if (uvVal1) uvVal1.textContent = isNum(uv) ? uv.toFixed(1) : "—";

  if (moonVal1) moonVal1.textContent = data?.moon?.phase ?? "—";
}

function setTidesLoadingState(isLoading) {
  // we reuse the same empty area as “loading”
  if (!tidesEmpty) return;
  if (isLoading) {
    tidesEmpty.classList.remove("hidden");
    tidesEmpty.textContent = "Loading tide data…";
  }
}

function renderTides(data) {
  if (!tidesList || !tidesEmpty || !nextTide || !nextTideHint || !tideStation) return;

  tidesList.innerHTML = "";
  tidesEmpty.classList.add("hidden");

  const station = data?.tideStation?.name;
  tideStation.textContent = station ? `Station: ${station}` : "Station: —";

  const tides = Array.isArray(data?.tides) ? data.tides : [];

  if (!tides.length) {
    tidesEmpty.classList.remove("hidden");

    // If quota exceeded, show why (without dumping huge debug)
    const dbg = data?.tides_debug?.error || "";
    if (String(dbg).includes("quota exceeded") || String(dbg).includes("402")) {
      tidesEmpty.textContent = "Tide data temporarily unavailable (API quota reached).";
    } else {
      tidesEmpty.textContent = "No tide data returned for this location.";
    }

    nextTide.textContent = "—";
    nextTideHint.textContent = "—";
    return;
  }

  tides.slice(0, 6).forEach((t) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div style="font-weight:800">${escapeHtml(time(t?.time))}</div>
      <div class="muted">${escapeHtml(isNum(t?.height) ? `${t.height.toFixed(2)} m` : "—")}</div>
      <div class="tag">${escapeHtml(String(t?.type || "—").toUpperCase())}</div>
    `;
    tidesList.appendChild(row);
  });

  const now = Date.now();
  const next = tides
    .map((t) => ({ ...t, ms: Date.parse(t.time) }))
    .filter((t) => Number.isFinite(t.ms) && t.ms > now)
    .sort((a, b) => a.ms - b.ms)[0];

  if (next) {
    nextTide.textContent = `${time(next.time)} • ${String(next.type || "").toUpperCase()}`;
    nextTideHint.textContent = isNum(next.height) ? `${next.height.toFixed(2)} m` : "";
  } else {
    nextTide.textContent = "No upcoming tide found";
    nextTideHint.textContent = "";
  }
}

// ---------- Helpers ----------
function time(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
}

function prettyDate(yyyy_mm_dd) {
  const [y, m, d] = String(yyyy_mm_dd || "").split("-").map(Number);
  if (!y || !m || !d) return "—";
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(dt);
}

function uvLabel(v) {
  if (v < 3) return "Low";
  if (v < 6) return "Moderate";
  if (v < 8) return "High";
  if (v < 11) return "Very High";
  return "Extreme";
}

function isNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function round(n, p) {
  const pow = 10 ** p;
  return Math.round(n * pow) / pow;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}
