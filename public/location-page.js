console.log("LOCATION PAGE JS LOADED");

const DEFAULT = window.PAGE_LOCATION || { name: "Brisbane", lat: -27.4698, lon: 153.0251 };

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

init();

function showLoading(on) {
  if (!loading) return;
  loading.classList.toggle("hidden", !on);
}

function setStatus(text) {
  if (pillStatus) pillStatus.textContent = text;
}

async function init() {
  await loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name);
}

async function loadFor(lat, lon, label) {
  showLoading(true);
  setStatus("Loading…");

  if (pillPlace) {
    pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;
  }

  try {
    const [today, tomorrow] = await Promise.all([
      fetchSummaryWithTimeout(lat, lon, 0),
      fetchSummaryWithTimeout(lat, lon, 1),
    ]);

    renderToday(today);
    renderTomorrow(tomorrow);
    setStatus("Updated");
  } catch (err) {
    console.error(err);
    setStatus("Error");
    alert("Could not load data. Please try again.");
  } finally {
    showLoading(false);
  }
}

async function fetchSummaryWithTimeout(lat, lon, day, msTimeout = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), msTimeout);

  try {
    const url =
      `/api/summary?lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lon)}` +
      `&day=${encodeURIComponent(day)}` +
      `&v=location1`;

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

function renderToday(data) {
  if (pillDate) pillDate.textContent = `Date: ${prettyDate(data?.date)}`;

  if (sunriseVal) sunriseVal.textContent = time(data?.sun?.sunrise);
  if (sunsetVal) sunsetVal.textContent = time(data?.sun?.sunset);

  const uv = data?.uv?.max;
  if (uvVal) uvVal.textContent = isNum(uv) ? uv.toFixed(1) : "—";
  if (uvHint) uvHint.textContent = isNum(uv) ? uvLabel(uv) : "—";

  if (moonVal) moonVal.textContent = data?.moon?.phase ?? "—";
  if (moonHint) {
    moonHint.textContent = isNum(data?.moon?.illuminationPct)
      ? `${data.moon.illuminationPct}% illuminated`
      : "—";
  }

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
    tidesEmpty.textContent = "No tide data returned for this location.";
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

function time(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}
