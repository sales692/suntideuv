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
el("btnLocate").addEventListener("click", () => locateAndLoad());
el("btnBrisbane").addEventListener("click", () =>
  loadFor(DEFAULT.lat, DEFAULT.lon, DEFAULT.name)
);

// Init
init();

async function init() {
  pillStatus.textContent = "Getting location…";
  await locateAndLoad({ quietFail: true });
}

function showLoading(on) {
  loading.classList.toggle("hidden", !on);
}

// Location
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

// Main loader
async function loadFor(lat, lon, label) {
  try {
    showLoading(true);
    pillStatus.textContent = "Loading…";
    pillPlace.textContent = `Location: ${label} (${lat}, ${lon})`;

    const [today, tomorrow] = await Promise.all([
      fetchSummary(lat, lon, 0),
      fetchSummary(lat, lon, 1),
    ]);

    renderToday(today);
    renderTomorrow(tomorrow);

    pillStatus.textContent = "Updated";
  } catch (err) {
    console.error(err);
    pillStatus.textContent = "Error";
    alert("Could not load data.");
  } finally {
    showLoading(false);
  }
}

// API
async function fetchSummary(lat, lon, day) {
  const res = await fetch(
    `/api/summary?lat=${lat}&lon=${lon}&day=${day}`
  );
  if (!res.ok) throw new Error("API error");
  return res.json();
}

// Render
function renderToday(data) {
  pillDate.textContent = `Date: ${prettyDate(data.date)}`;

  sunriseVal.textContent = time(data.sun.sunrise);
  sunsetVal.textContent = time(data.sun.sunset);

  uvVal.textContent = data.uv?.max?.toFixed(1) ?? "—";
  uvHint.textContent = uvLabel(data.uv?.max);

  moonVal.textContent = data.moon?.phase ?? "—";
  moonHint.textContent = data.moon?.illuminationPct
    ? `${data.moon.illuminationPct}% illuminated`
    : "—";

  renderTides(data);
}

function renderTomorrow(data) {
  sunriseVal1.textContent = time(data.sun.sunrise);
  sunsetVal1.textContent = time(data.sun.sunset);
  uvVal1.textContent = data.uv?.max?.toFixed(1) ?? "—";
  moonVal1.textContent = data.moon?.phase ?? "—";
}

function renderTides(data) {
  tidesList.innerHTML = "";
  tidesEmpty.classList.add("hidden");

  tideStation.textContent = data.tideStation
    ? `Station: ${data.tideStation.name}`
    : "Station: —";

  if (!data.tides?.length) {
    tidesEmpty.classList.remove("hidden");
    return;
  }

  data.tides.slice(0, 6).forEach((t) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div><strong>${time(t.time)}</strong></div>
      <div class="muted">${t.height.toFixed(2)} m</div>
      <div class="tag">${t.type.toUpperCase()}</div>
    `;
    tidesList.appendChild(row);
  });

  const next = data.tides.find(t => Date.parse(t.time) > Date.now());
  if (next) {
    nextTide.textContent = `${time(next.time)} • ${next.type.toUpperCase()}`;
    nextTideHint.textContent = `${next.height.toFixed(2)} m`;
  }
}

// Helpers
function time(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function prettyDate(d) {
  return new Date(d).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}
function uvLabel(v) {
  if (v < 3) return "Low";
  if (v < 6) return "Moderate";
  if (v < 8) return "High";
  if (v < 11) return "Very High";
  return "Extreme";
}
function round(n, p) {
  return Math.round(n * 10 ** p) / 10 ** p;
}
