console.log("APP JS VERSION 5 LOADED");
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

// ---------- UI helpers ----------
function showLoading(on) {
  if (!loading) return;
  loading.classList.toggle("hidden", !on);
}

function setStatus(text) {
  if (pillStatus) pillStatus.textContent = text;
}

// ---------- App flow ----------
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
  try {
    showLoading(true);
    setStatus("Loading…");
    if (pillPlace) pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

    const results = await Promise.allSettled([
  fetchSummaryCached(lat, lon, 0),
  fetchSummaryCached(lat, lon, 1),
]);

const today = results[0].status === "fulfilled" ? results[0].value : null;
const tomorrow = results[1].status === "fulfilled" ? results[1].value : null;

if (today) renderToday(today);
if (tomorrow) renderTomorrow(tomorrow);

    setStatus("Updated");
  } catch (err) {
    console.error(err);
    setStatus("Error");
    alert("Could not load data. Please try again.");
  } finally {
    showLoading(false);
  }
}

// ---------- Data fetching ----------
async function fetchSummaryWithTimeout(lat, lon, day, msTimeout = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), msTimeout);

  try {
    const url = `/api/summary?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(
      lon
    )}&day=${encodeURIComponent(day)}&v=1`;

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

function cacheKey(lat, lon, day) {
  // slightly rounded so cache hits even with tiny GPS changes
  const rLat = Math.round(lat * 100) / 100;
  const rLon = Math.round(lon * 100) / 100;
  return `suntideuv:v2:${rLat}:${rLon}:d${day}`;
}

async function fetchSummaryCached(lat, lon, day) {
  const key = cacheKey(lat, lon, day);
  const now = Date.now();

  // Cache for 10 minutes
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached && cached.exp > now && cached.data) return cached.data;
  } catch {
    // ignore cache parse errors
  }

  const data = await fetchSummaryWithTimeout(lat, lon, day, 8000);

  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        exp: now + 10 * 60 * 1000,
        data,
      })
    );
  } catch {
    // ignore storage quota errors
  }

  return data;
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

  renderTides(data);
}

function renderTomorrow(data) {
  if (sunriseVal1) sunriseVal1.textContent = time(data?.sun?.sunrise);
  if (sunsetVal1) sunsetVal1.textContent = time(data?.sun?.sunset);

  const uv = data?.uv?.max;
  if (uvVal1) uvVal1.textContent = isNum(uv) ? uv.toFixed(1) : "—";

  if (moonVal1) moonVal1.textContent = data?.moon?.phase ?? "—";
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
  nextTide.textContent = "—";
  nextTideHint.textContent = "—";
  return;
}

  // Always show next 6 tides (best UX, avoids date/timezone edge cases)
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

  // Next tide = first future tide
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
