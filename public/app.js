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

el("btnLocate").addEventListener("click", () => locateAndLoad());
el("btnBrisbane").addEventListener("click", () =>
  loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name)
);

init();

function showLoading(on) {
  if (!loading) return;
  loading.classList.toggle("hidden", !on);
}

async function init() {
  pillStatus.textContent = "Getting location…";
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
    { timeout: 8000 }
  );
}

async function loadFor(lat, lon, label) {
  showLoading(true);
  pillStatus.textContent = "Loading…";
  pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

  try {
    const [today, tomorrow] = await Promise.all([
      fetchSummaryWithTimeout(lat, lon, 0, 12000),
      fetchSummaryWithTimeout(lat, lon, 1, 12000),
    ]);

    renderToday(today);
    renderTomorrow(tomorrow);

    pillStatus.textContent = "Updated";
  } catch (err) {
    console.error("Load error:", err);
    pillStatus.textContent = "Error loading data";
    alert("Could not load data. Please try again.");
  } finally {
    showLoading(false);
  }
}

async function fetchSummaryWithTimeout(lat, lon, day, msTimeout) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), msTimeout);

  try {
    const res = await fetch(`/api/summary?lat=${lat}&lon=${lon}&day=${day}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text.slice(0, 120)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Render
function renderToday(data) {
  pillDate.textContent = `Date: ${prettyDate(data.date)}`;

  sunriseVal.textContent = time(data?.sun?.sunrise);
  sunsetVal.textContent = time(data?.sun?.sunset);

  const uv = data?.uv?.max;
  uvVal.textContent = isNum(uv) ? uv.toFixed(1) : "—";
  uvHint.textContent = isNum(uv) ? uvLabel(uv) : "—";

  moonVal.textContent = data?.moon?.phase ?? "—";
  moonHint.textContent = isNum(data?.moon?.illuminationPct)
    ? `${data.moon.illuminationPct}% illuminated`
    : "—";

  renderTides(data);
}

function renderTomorrow(data) {
  sunriseVal1.textContent = time(data?.sun?.sunrise);
  sunsetVal1.textContent = time(data?.sun?.sunset);

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

  // Show first 6
  tides.slice(0, 6).forEach((t) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div style="font-weight:800">${escapeHtml(time(t.time))}</div>
      <div class="muted">${escapeHtml(isNum(t.height) ? `${t.height.toFixed(2)} m` : "—")}</div>
      <div class="tag">${escapeHtml((t.type || "—").toUpperCase())}</div>
    `;
    tidesList.appendChild(row);
  });

  const now = Date.now();
  const next = tides
    .map((t) => ({ ...t, ms: Date.parse(t.time) }))
    .filter((t) => Number.isFinite(t.ms) && t.ms > now)
    .sort((a, b) => a.ms - b.ms)[0];

  if (next) {
    nextTide.textContent = `${time(next.time)} • ${(next.type || "").toUpperCase()}`;
    nextTideHint.textContent = isNum(next.height) ? `${next.height.toFixed(2)} m` : "";
  } else {
    nextTide.textContent = "No upcoming tide found";
    nextTideHint.textContent = "";
  }
}

// Helpers
function time(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
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
  return Math.round(n * 10 ** p) / 10 ** p;
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
