const DEFAULT = { name: "Brisbane", lat: -27.4698, lon: 153.0251 };

const el = (id) => document.getElementById(id);
const must = (id) => {
  const node = el(id);
  if (!node) throw new Error(`Missing element #${id} in index.html`);
  return node;
};

// Required elements (matches your index.html)
const loading = must("loading");

const pillStatus = must("pillStatus");
const pillPlace = must("pillPlace");
const pillDate = must("pillDate");

const sunriseVal = must("sunriseVal");
const sunsetVal = must("sunsetVal");
const uvVal = must("uvVal");
const uvHint = must("uvHint");
const moonVal = must("moonVal");
const moonHint = must("moonHint");

const nextTide = must("nextTide");
const nextTideHint = must("nextTideHint");
const tideStation = must("tideStation");
const tidesList = must("tidesList");
const tidesEmpty = must("tidesEmpty");

const sunriseVal1 = must("sunriseVal1");
const sunsetVal1 = must("sunsetVal1");
const uvVal1 = must("uvVal1");
const moonVal1 = must("moonVal1");

const btnLocate = must("btnLocate");
const btnBrisbane = must("btnBrisbane");

function showLoading(on) {
  loading.classList.toggle("hidden", !on);
}

function setStatus(text) {
  pillStatus.textContent = text;
}

btnLocate.addEventListener("click", () => locateAndLoad());
btnBrisbane.addEventListener("click", () =>
  loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name)
);

init();

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
    pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

    const [today, tomorrow] = await Promise.all([
      fetchSummaryCached(lat, lon, 0),
      fetchSummaryCached(lat, lon, 1),
    ]);

    renderToday(today);
    renderTomorrow(tomorrow);

    setStatus("Updated");
  } catch (err) {
    console.error("Load failed:", err);
    setStatus("Error");
    alert(`Could not load data.\n\n${String(err.message || err).slice(0, 200)}`);
  } finally {
    showLoading(false);
  }
}

async function fetchSummary(lat, lon, day) {
  const url =
    `/api/summary?lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lon)}` +
    `&day=${encodeURIComponent(day)}` +
    `&v=1`;

  const res = await fetch(url, { headers: { accept: "application/json" } });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function cacheKey(lat, lon, day) {
  // round for better cache hits
  const rLat = Math.round(lat * 100) / 100;
  const rLon = Math.round(lon * 100) / 100;
  return `suntideuv:v1:${rLat}:${rLon}:d${day}`;
}

async function fetchSummaryCached(lat, lon, day) {
  const key = cacheKey(lat, lon, day);
  const now = Date.now();

  // Try cache (10 minutes)
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached && cached.exp > now && cached.data) return cached.data;
  } catch {}

  // Fetch fresh
  const data = await fetchSummary(lat, lon, day);

  // Save cache
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ exp: now + 10 * 60 * 1000, data })
    );
  } catch {}

  return data;
}

function renderToday(data) {
  pillDate.textContent = `Date: ${prettyDateFromISO(data?.date)}`;

  sunriseVal.textContent = fmtTimeLocal(data?.sun?.sunrise);
  sunsetVal.textContent = fmtTimeLocal(data?.sun?.sunset);

  const uv = data?.uv?.max;
  uvVal.textContent = isNum(uv) ? uv.toFixed(1) : "—";
  uvHint.textContent = isNum(uv) ? uvCategory(uv) : "—";

  moonVal.textContent = data?.moon?.phase ?? "—";
  moonHint.textContent = isNum(data?.moon?.illuminationPct)
    ? `${data.moon.illuminationPct}% illuminated`
    : "—";

  renderTides(data);
}

function renderTomorrow(data) {
  sunriseVal1.textContent = fmtTimeLocal(data?.sun?.sunrise);
  sunsetVal1.textContent = fmtTimeLocal(data?.sun?.sunset);

  const uv = data?.uv?.max;
  uvVal1.textContent = isNum(uv) ? uv.toFixed(1) : "—";

  moonVal1.textContent = data?.moon?.phase ?? "—";
}

function renderTides(data) {
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

  // Build rows for "today" only (match data.date)
  const todayISO = data?.date;
  const todays = todayISO
    ? tides.filter((t) => (t?.time || "").startsWith(todayISO))
    : [];

  const list = todays.length ? todays : tides.slice(0, 6);

  for (const t of list) {
    const time = fmtTimeLocal(t?.time);
    const h = isNum(t?.height) ? `${t.height.toFixed(2)} m` : "—";
    const type = (t?.type || "").toUpperCase() || "—";
    tidesList.appendChild(row(time, h, type));
  }

  // Next tide based on now
  const now = Date.now();
  const next = tides
    .map((t) => ({ ...t, ms: Date.parse(t?.time) }))
    .filter((t) => Number.isFinite(t.ms) && t.ms > now)
    .sort((a, b) => a.ms - b.ms)[0];

  if (next) {
    nextTide.textContent = `${fmtTimeLocal(next.time)} • ${String(
      next.type || ""
    ).toUpperCase()}`;
    nextTideHint.textContent = isNum(next.height) ? `${next.height.toFixed(2)} m` : "";
  } else {
    nextTide.textContent = "No upcoming tide found";
    nextTideHint.textContent = "";
  }
}

function row(left, mid, tag) {
  const div = document.createElement("div");
  div.className = "row";
  div.innerHTML = `
    <div style="font-weight:800">${escapeHtml(left)}</div>
    <div class="muted">${escapeHtml(mid)}</div>
    <div class="tag">${escapeHtml(tag)}</div>
  `;
  return div;
}

function fmtTimeLocal(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function prettyDateFromISO(yyyy_mm_dd) {
  const [y, m, d] = String(yyyy_mm_dd || "").split("-").map(Number);
  if (!y || !m || !d) return "—";
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(dt);
}

function uvCategory(v) {
  if (v < 3) return "Low";
  if (v < 6) return "Moderate";
  if (v < 8) return "High";
  if (v < 11) return "Very High";
  return "Extreme";
}

function isNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function round(x, dp) {
  const p = 10 ** dp;
  return Math.round(x * p) / p;
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
