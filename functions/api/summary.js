export async function onRequestGet(context) {
  const { request } = context;
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ ok: false, error: "lat and lon required" }, 400);
  }

  const d = new Date();
  d.setUTCDate(d.getUTCDate() + day);
  const dateStr = d.toISOString().slice(0, 10);

  const result = {
    ok: true,
    location: { lat, lon },
    date: dateStr,
    sun: null,
    uv: { max: null },
    moon: calcMoon(dateStr),
    tides: [],
    tideStation: null
  };

  // ---------- SUN ----------
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}` +
      `&date=${dateStr}&formatted=0`;

    const sun = await cachedJson(context, sunUrl, 12 * 60 * 60);
    result.sun = sun?.results ?? null;
  } catch {}

  // ---------- UV ----------
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&timezone=auto`;

    const uv = await cachedJson(context, uvUrl, 60 * 60);
    result.uv.max = uv?.daily?.uv_index_max?.[day] ?? null;
  } catch {}

  // ---------- FREE TIDES ----------
  try {
    const station = findNearestStation(lat, lon);
    if (station) {
      const tides = await fetchNoaaTides(context, station, dateStr);
      result.tides = tides;
      result.tideStation = { name: station.name };
    }
  } catch {}

  return json(result, 200, {
    "cache-control": "public, s-maxage=300"
  });
}

/* ================== FREE TIDE SOURCE ================== */

const TIDE_STATIONS = [
  {
    id: "PORT_BRISBANE",
    name: "Port of Brisbane",
    lat: -27.38,
    lon: 153.17,
    stationId: "9414290"
  }
];

function findNearestStation(lat, lon) {
  let best = null;
  let bestDist = Infinity;

  for (const s of TIDE_STATIONS) {
    const d = Math.hypot(lat - s.lat, lon - s.lon);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

async function fetchNoaaTides(context, station, dateStr) {
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?product=predictions` +
    `&application=suntideuv` +
    `&begin_date=${dateStr.replace(/-/g, "")}` +
    `&end_date=${dateStr.replace(/-/g, "")}` +
    `&datum=MSL` +
    `&station=${station.stationId}` +
    `&time_zone=gmt` +
    `&units=metric` +
    `&interval=hilo` +
    `&format=json`;

  const json = await cachedJson(context, url, 12 * 60 * 60);
  if (!Array.isArray(json?.predictions)) return [];

  return json.predictions.map(t => ({
    time: t.t,
    height: Number(t.v),
    type: t.type
  }));
}

/* ================== CACHE HELPERS ================== */

async function cachedJson(context, url, ttl) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const res = await fetch(url);
  const data = await res.json();

  context.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, s-maxage=${ttl}`
        }
      })
    )
  );

  return data;
}

/* ================== UTILITIES ================== */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function calcMoon(dateStr) {
  const epoch = Date.UTC(2000, 0, 6, 18, 14, 0);
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  const synodic = 29.530588853 * 86400000;
  let age = (t - epoch) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic;
  return {
    phase: phaseName(frac),
    illuminationPct: Math.round(((1 - Math.cos(2 * Math.PI * frac)) / 2) * 100)
  };
}

function phaseName(frac) {
  const x = frac * 8;
  return [
    "New Moon",
    "Waxing Crescent",
    "First Quarter",
    "Waxing Gibbous",
    "Full Moon",
    "Waning Gibbous",
    "Last Quarter",
    "Waning Crescent"
  ][Math.floor(x)] || "New Moon";
}
