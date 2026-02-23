const DEFAULT = { name: "Brisbane", lat: -27.4698, lon: 153.0251 };

const el = (id) => document.getElementById(id);

const pillStatus = el("pillStatus");
const pillPlace = el("pillPlace");
const pillDate = el("pillDate");

const sunriseVal = el("sunriseVal");
const sunsetVal = el("sunsetVal");
const uvVal = el("uvVal");
const uvHint = el("uvHint");
const moonVal = el("moonVal");
const moonHint = el("moonHint");

const nextTide = el("nextTide");
const nextTideHint = el("nextTideHint");
const tideStation = el("tideStation");
const tidesList = el("tidesList");
const tidesEmpty = el("tidesEmpty");

const sunriseVal1 = el("sunriseVal1");
const sunsetVal1 = el("sunsetVal1");
const uvVal1 = el("uvVal1");
const moonVal1 = el("moonVal1");

el("btnLocate").addEventListener("click", () => locateAndLoad());
el("btnBrisbane").addEventListener("click", () => loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name));

init();

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
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
  );
}

async function loadFor(lat, lon, label) {
  try {
    setStatus("Loading…");
    pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

    // today + tomorrow
    const [today, tomorrow] = await Promise.all([
      fetchSummary(lat, lon, 0),
      fetchSummary(lat, lon, 1)
    ]);

    render(today, { dayLabel: "Today" });
    renderTomorrow(tomorrow);

    setStatus("Updated");
  } catch (err) {
    console.error(err);
    setStatus("Error");
    alert("Could not load data. Please try again.");
  }
}

async function fetchSummary(lat, lon, day) {
  const url = `/api/summary?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&day=${encodeURIComponent(day)}&v=1`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function render(data) {
  pillDate.textContent = `Date: ${prettyDateFromISO(data.date)}`;

  // Sun
  sunriseVal.textContent = fmtTimeLocal(data?.sun?.sunrise);
  sunsetVal.textContent = fmtTimeLocal(data?.sun?.sunset);

  // UV
  const uv = data?.uv?.max;
  uvVal.textContent = isNum(uv) ? uv.toFixed(1) : "—";
  uvHint.textContent = isNum(uv) ? uvCategory(uv) : "—";

  // Moon
  moonVal.textContent = data?.moon?.phase ?? "—";
  moonHint.textContent = isNum(data?.moon?.illuminationPct)
    ? `${data.moon.illuminationPct}% illuminated`
    : "—";

  // Tides
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

  if (tides.length === 0) {
    tidesEmpty.classList.remove("hidden");
    nextTide.textContent = "—";
    nextTideHint.textContent = "—";
    return;
  }

  // Build rows for "today" only (match data.date)
  const todayISO = data.date;
  const todays = tides.filter(t => (t?.time || "").startsWith(todayISO));

  const list = todays.length ? todays : tides.slice(0, 6);

  for (const t of list) {
    const time = fmtTimeLocal(t.time);
    const h = isNum(t.height) ? `${t.height.toFixed(2)} m` : "—";
    const type = (t.type || "").toUpperCase() || "—";
    tidesList.appendChild(row(`${time}`, h, type));
  }

  // Next tide based on now
  const now = Date.now();
  const next = tides
    .map(t => ({ ...t, ms: Date.parse(t.time) }))
    .filter(t => Number.isFinite(t.ms) && t.ms > now)
    .sort((a, b) => a.ms - b.ms)[0];

  if (next) {
    nextTide.textContent = `${fmtTimeLocal(next.time)} • ${next.type.toUpperCase()}`;
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

function setStatus(text) {
  pillStatus.textContent = text;
}

function fmtTimeLocal(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
}

function prettyDateFromISO(yyyy_mm_dd) {
  // interpret as local date
  const [y, m, d] = (yyyy_mm_dd || "").split("-").map(Number);
  if (!y || !m || !d) return "—";
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short" }).format(dt);
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
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}
