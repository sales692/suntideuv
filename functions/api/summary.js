export async function onRequestGet(context) {
  const { request } = context;
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }

  // Build date string (UTC) for "today + day"
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
    tideStation: null,
    tides_debug: { provider: "qld_ckan", enabled: true }
  };

  // ---- SUN (cached 12 hours) ----
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}` +
      `&date=${encodeURIComponent(dateStr)}&formatted=0`;

    const sunJson = await cachedFetchJson(context, sunUrl, { cacheTtlSeconds: 12 * 60 * 60 });
    result.sun = sunJson?.results ?? null;
  } catch {
    result.sun = null;
  }

  // ---- UV (cached 1 hour) ----
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&timezone=auto`;

    const uvJson = await cachedFetchJson(context, uvUrl, { cacheTtlSeconds: 60 * 60 });
    result.uv.max = uvJson?.daily?.uv_index_max?.[day] ?? null;
  } catch {
    result.uv.max = null;
  }

  // ---- TIDES (Queensland CKAN) ----
  try {
    // Load your station list from your own site
    const origin = new URL(request.url).origin;
    const stationsUrl = `${origin}/data/tide_stations_qld.json`;

    const stations = await cachedFetchJson(context, stationsUrl, { cacheTtlSeconds: 24 * 60 * 60 });
    if (!Array.isArray(stations) || !stations.length) throw new Error("No stations found in tide_stations_qld.json");

    const station = findNearestStation(lat, lon, stations);
    result.tideStation = { name: station.name, lat: station.lat, lon: station.lon };

    const year = Number(dateStr.slice(0, 4));
    const tz = station.tz_offset || "+10:00";

    // Pick a resource_id for the year; you can expand these keys as you add more years
    const rid =
      station[`resource_id_interval_${year}`] ||
      station.resource_id_interval_2026 || // fallback if you only populate 2026 initially
      null;

    if (!rid) {
      result.tides_debug.error = `No resource id found for ${station.name} (year ${year})`;
    } else {
      // Pull enough data to determine next high/low reliably:
      // For daily view, grab today + tomorrow (2 days of 10-min data ≈ 576 rows)
      const dates = day === 0 ? [dateStr, addDaysUTC(dateStr, 1)] : [dateStr];
      const readings = await fetchIntervalReadingsCKAN(context, rid, dates);

      // Convert readings -> time series, compute turning points
      const series = readings
        .map(r => {
          const iso = toIsoWithOffset(r.Date, r.Time, tz);
          const value = Number(r.Reading);
          return { iso, ms: Date.parse(iso), value };
        })
        .filter(p => Number.isFinite(p.ms) && Number.isFinite(p.value))
        .sort((a, b) => a.ms - b.ms);

      const extremes = detectHighLow(series);

      // Convert to your UI shape (limit to 12, UI shows 6 anyway)
      result.tides = extremes.slice(0, 12).map(e => ({
        time: e.iso,
        height: e.value,
        type: e.type
      }));
    }
  } catch (e) {
    // Tide failures should not break the whole page
    result.tides = [];
    result.tideStation = null;
    result.tides_debug.error = String(e);
  }

  return json(result, 200, {
    "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600"
  });
}

/* ----------------- CKAN fetch ----------------- */

// Uses datastore_search_sql so we can filter by Date in one request.
// CKAN supports SQL endpoint /api/3/action/datastore_search_sql (shown in CKAN API modal). :contentReference[oaicite:3]{index=3}
async function fetchIntervalReadingsCKAN(context, resourceId, dates) {
  const where = dates.map(d => `Date='${d}'`).join(" OR ");
  const sql =
    `SELECT Date, Time, Reading ` +
    `FROM "${resourceId}" ` +
    `WHERE ${where} ` +
    `ORDER BY Date, Time ` +
    `LIMIT 2000`;

  const url = `https://www.data.qld.gov.au/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`;

  const data = await cachedFetchJson(context, url, { cacheTtlSeconds: 6 * 60 * 60 });
  const records = data?.result?.records;
  return Array.isArray(records) ? records : [];
}

/* ----------------- Tide math ----------------- */

function detectHighLow(series) {
  // turning points where slope changes sign
  const out = [];
  if (series.length < 3) return out;

  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1], b = series[i], c = series[i + 1];
    const up1 = b.value > a.value;
    const up2 = c.value > b.value;

    if (up1 && !up2) out.push({ ...b, type: "HIGH" }); // rising then falling
    if (!up1 && up2) out.push({ ...b, type: "LOW" });  // falling then rising
  }

  // De-dupe: if multiple points flat at peak/trough, keep the first
  const deduped = [];
  for (const p of out) {
    const last = deduped[deduped.length - 1];
    if (last && last.type === p.type && Math.abs(last.value - p.value) < 0.001) continue;
    deduped.push(p);
  }

  // Only future-ish points preferred (but keep all if time parsing odd)
  const now = Date.now();
  const future = deduped.filter(p => p.ms > now);
  return future.length ? future : deduped;
}

function findNearestStation(lat, lon, stations) {
  let best = null;
  let bestD = Infinity;
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best) throw new Error("No valid station lat/lon");
  return best;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toIsoWithOffset(dateStr, timeStr, tzOffset) {
  // CKAN provides Date + Time as text fields. :contentReference[oaicite:4]{index=4}
  // timeStr often "HH:MM" or "HH:MM:SS"
  const t = (timeStr || "").trim();
  const hhmmss = t.length === 5 ? `${t}:00` : t;
  return `${dateStr}T${hhmmss}${tzOffset}`;
}

function addDaysUTC(yyyy_mm_dd, days) {
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* ----------------- Cloudflare cache helpers ----------------- */

async function cachedFetchJson(context, url, opts = {}) {
  const text = await cachedFetchText(context, url, opts);
  return JSON.parse(text);
}

async function cachedFetchText(context, url, opts = {}) {
  const cacheTtlSeconds = Number(opts.cacheTtlSeconds || 600);
  const headers = opts.headers || {};

  const cacheKey = new Request(url, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.text();

  const res = await fetch(url, { headers });
  const text = await res.text();

  if (res.ok) {
    const toCache = new Response(text, {
      headers: {
        "content-type": res.headers.get("content-type") || "application/json",
        "cache-control": `public, max-age=0, s-maxage=${cacheTtlSeconds}`
      }
    });
    context.waitUntil(cache.put(cacheKey, toCache));
  }

  if (!res.ok) {
    throw new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`);
  }

  return text;
}

/* ----------------- Utilities ----------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function calcMoon(dateStr) {
  const epoch = Date.UTC(2000, 0, 6, 18, 14, 0);
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  const synodic = 29.530588853 * 86400000;

  let age = (t - epoch) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic;

  const illuminationPct = Math.round(((1 - Math.cos(2 * Math.PI * frac)) / 2) * 100);
  const phase = phaseName(frac);

  return { phase, illuminationPct };
}

function phaseName(frac) {
  const x = frac * 8;
  if (x < 0.5) return "New Moon";
  if (x < 1.5) return "Waxing Crescent";
  if (x < 2.5) return "First Quarter";
  if (x < 3.5) return "Waxing Gibbous";
  if (x < 4.5) return "Full Moon";
  if (x < 5.5) return "Waning Gibbous";
  if (x < 6.5) return "Last Quarter";
  if (x < 7.5) return "Waning Crescent";
  return "New Moon";
}
