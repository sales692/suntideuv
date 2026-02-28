// /functions/api/summary.js
// Free tides via MSQ Open Data (CKAN DataStore), with strong edge caching.
//
// References:
// CKAN datastore_search uses: /api/3/action/datastore_search?resource_id={RESOURCE_ID}
// CKAN docs show DataStore API patterns. (docs.ckan.org)  :contentReference[oaicite:2]{index=2}

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
    tides_debug: {
      source: "msq_ckan",
      stationCount: null,
      chosenStation: null,
      errors: []
    }
  };

  // ---- SUN (cached 12 hours) ----
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}` +
      `&date=${encodeURIComponent(dateStr)}` +
      `&formatted=0`;

    const sunJson = await cachedFetchJson(context, sunUrl, {
      cacheTtlSeconds: 12 * 60 * 60
    });

    result.sun = sunJson?.results ?? null;
  } catch (e) {
    result.sun = null;
    result.tides_debug.errors.push(`SUN: ${String(e)}`);
  }

  // ---- UV (cached 1 hour) ----
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&timezone=auto`;

    const uvJson = await cachedFetchJson(context, uvUrl, {
      cacheTtlSeconds: 60 * 60
    });

    result.uv.max = uvJson?.daily?.uv_index_max?.[day] ?? null;
  } catch (e) {
    result.uv.max = null;
    result.tides_debug.errors.push(`UV: ${String(e)}`);
  }

  // ---- TIDES (MSQ / CKAN) ----
  // Strategy:
  // - Load stations list from repo (cached 24h at edge)
  // - Pick nearest station to requested lat/lon
  // - Query CKAN datastore_search for the date window
  // - Normalize to [{ time, height, type }]
  //
  // Cache: tides for a station+date cached at edge for 6 hours (configurable)
  const tideCacheHours = 6;
  try {
    const stations = await loadStations(context);
    result.tides_debug.stationCount = stations.length;

    const station = pickNearestStation(stations, lat, lon);
    if (!station) {
      throw new Error("No tide stations available (stations file empty?)");
    }

    result.tideStation = { name: station.name };
    result.tides_debug.chosenStation = station.name;

    // We fetch a 2-day window to support "next tide" properly
    const startISO = `${dateStr}T00:00:00Z`;
    const endDate = new Date(`${dateStr}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + 2);
    const endStr = endDate.toISOString().slice(0, 10);
    const endISO = `${endStr}T00:00:00Z`;

    const tides = await fetchCkanHighLowForWindow(context, {
      resourceId: station.resource_id_highlow,
      startISO,
      endISO,
      cacheTtlSeconds: tideCacheHours * 60 * 60
    });

    result.tides = tides;
  } catch (e) {
    // Tide errors should NOT break the page
    result.tides = [];
    result.tideStation = result.tideStation ?? null;
    result.tides_debug.errors.push(`TIDES: ${String(e)}`);
  }

  // Cache the summary response briefly so refreshes don't hammer anything
  return json(result, 200, {
    "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600"
  });
}

/* ----------------- Stations ----------------- */

async function loadStations(context) {
  // Stations file is deployed as a static asset.
  // IMPORTANT: This path assumes you keep it in /data/tide_stations_qld.json
  // and it’s included in the Pages assets.
  const url = new URL(context.request.url);
  const stationsUrl = `${url.origin}/data/tide_stations_qld.json`;

  // Cache at edge 24h
  const data = await cachedFetchJson(context, stationsUrl, {
    cacheTtlSeconds: 24 * 60 * 60
  });

  if (!Array.isArray(data)) return [];
  return data
    .filter((s) => s && typeof s.name === "string")
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .filter((s) => typeof s.resource_id_highlow === "string" && s.resource_id_highlow.length > 10);
}

function pickNearestStation(stations, lat, lon) {
  if (!stations.length) return null;

  let best = stations[0];
  let bestD = haversineKm(lat, lon, best.lat, best.lon);

  for (let i = 1; i < stations.length; i++) {
    const s = stations[i];
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
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

/* ----------------- CKAN tides fetch ----------------- */

async function fetchCkanHighLowForWindow(context, { resourceId, startISO, endISO, cacheTtlSeconds }) {
  // CKAN DataStore API:
  // POST https://www.data.qld.gov.au/api/3/action/datastore_search
  // Body: { "resource_id": "...", "limit": 100, "filters": {...} } etc.
  //
  // Data shapes vary by dataset. So we:
  // - request a generous limit
  // - then normalize rows that have a timestamp + height + type

  const endpoint = "https://www.data.qld.gov.au/api/3/action/datastore_search";
  const cacheKey = `ckan:${resourceId}:${startISO}:${endISO}`;

  // Try cache first
  const cached = await cacheGetJson(context, cacheKey);
  if (cached) return cached;

  const body = {
    resource_id: resourceId,
    limit: 500
    // NOTE: many MSQ resources support filtering, but field names vary.
    // We’ll fetch and filter client-side in the Worker to avoid guessing field names here.
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CKAN ${res.status}: ${text.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`CKAN non-JSON response: ${text.slice(0, 200)}`);
  }

  const rows = payload?.result?.records;
  if (!Array.isArray(rows)) {
    throw new Error("CKAN response did not include records[]");
  }

  // Normalize:
  // We accept common field names:
  // - time: "time" | "date_time" | "datetime" | "timestamp" | "DateTime" etc
  // - height: "height" | "Height" | "prediction" | "value" etc
  // - type: "type" | "event" | "Tide" etc (HIGH/LOW)
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);

  const out = [];
  for (const r of rows) {
    const tRaw =
      r.time ?? r.date_time ?? r.datetime ?? r.timestamp ?? r.DateTime ?? r.DATE_TIME ?? null;
    const ms = Date.parse(String(tRaw || ""));
    if (!Number.isFinite(ms)) continue;
    if (Number.isFinite(startMs) && ms < startMs) continue;
    if (Number.isFinite(endMs) && ms >= endMs) continue;

    const hRaw =
      r.height ?? r.Height ?? r.prediction ?? r.value ?? r.Value ?? r.HEIGHT ?? null;
    const height = Number(hRaw);
    const typeRaw =
      r.type ?? r.event ?? r.Event ?? r.tide ?? r.Tide ?? r.TIDE ?? null;

    // Attempt to infer type if not explicitly provided
    const type = normalizeTideType(typeRaw);

    out.push({
      time: new Date(ms).toISOString(),
      height: Number.isFinite(height) ? height : null,
      type
    });
  }

  // Sort ascending
  out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  // Cache result
  await cachePutJson(context, cacheKey, out, cacheTtlSeconds);

  return out;
}

function normalizeTideType(x) {
  const s = String(x || "").toUpperCase();
  if (s.includes("HIGH")) return "HIGH";
  if (s.includes("LOW")) return "LOW";
  // Some datasets may store H/L, or "HW"/"LW"
  if (s === "H" || s === "HW") return "HIGH";
  if (s === "L" || s === "LW") return "LOW";
  return "—";
}

/* ----------------- Edge cache helpers ----------------- */

async function cachedFetchJson(context, url, { cacheTtlSeconds = 600 } = {}) {
  const text = await cachedFetchText(context, url, { cacheTtlSeconds });
  return JSON.parse(text);
}

async function cachedFetchText(context, url, { cacheTtlSeconds = 600 } = {}) {
  const cache = caches.default;
  const req = new Request(url, { method: "GET" });

  const hit = await cache.match(req);
  if (hit) return await hit.text();

  const res = await fetch(req);
  const text = await res.text();

  if (res.ok) {
    const toCache = new Response(text, {
      headers: {
        "content-type": res.headers.get("content-type") || "application/json",
        "cache-control": `public, max-age=0, s-maxage=${cacheTtlSeconds}`
      }
    });
    context.waitUntil(cache.put(req, toCache));
  }

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

// Small JSON cache bucket keyed by a synthetic string
async function cacheGetJson(context, key) {
  const cache = caches.default;
  const url = new URL(context.request.url);
  const req = new Request(`${url.origin}/__cache__/${encodeURIComponent(key)}`, { method: "GET" });
  const hit = await cache.match(req);
  if (!hit) return null;
  try {
    return await hit.json();
  } catch {
    return null;
  }
}

async function cachePutJson(context, key, data, ttlSeconds) {
  const cache = caches.default;
  const url = new URL(context.request.url);
  const req = new Request(`${url.origin}/__cache__/${encodeURIComponent(key)}`, { method: "GET" });

  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=0, s-maxage=${ttlSeconds}`
    }
  });

  context.waitUntil(cache.put(req, res));
}

/* ----------------- utilities ----------------- */

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
