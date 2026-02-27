export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }

  // Date (UTC): today + day
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
    tides_debug: { enabled: Boolean(env?.STORMGLASS_API_KEY) }
  };

  // -------- SUN (cache 12 hours) --------
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}` +
      `&date=${encodeURIComponent(dateStr)}` +
      `&formatted=0`;

    const sunJson = await cachedFetchJson(sunUrl, 12 * 60 * 60);
    result.sun = sunJson?.results ?? null;
  } catch {
    result.sun = null;
  }

  // -------- UV (cache 1 hour) --------
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&timezone=auto`;

    const uvJson = await cachedFetchJson(uvUrl, 60 * 60);
    result.uv.max = uvJson?.daily?.uv_index_max?.[day] ?? null;
  } catch {
    result.uv.max = null;
  }

  // -------- TIDES (Stormglass) --------
  // Only fetch tides for TODAY to reduce quota burn.
  if (day === 0) {
    const tides = await getTidesWithEdgeCache({ lat, lon, dateStr, env });
    result.tides = tides.data;
    result.tideStation = tides.station;
    result.tides_debug = { ...result.tides_debug, ...tides.debug };
  }

  // Short cache on the whole summary response (so refreshes don’t hammer you)
  return json(result, 200, {
    "cache-control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600"
  });
}

/* ---------------- Tides with edge cache + quota fallback ---------------- */

async function getTidesWithEdgeCache({ lat, lon, dateStr, env }) {
  const debug = {};
  const cache = caches.default;

  // Bucket locations a bit so tiny GPS shifts don’t create new cache keys
  const rLat = Math.round(lat * 100) / 100;
  const rLon = Math.round(lon * 100) / 100;

  const ttlHours = Number(env?.TIDE_CACHE_HOURS || 24); // set in Cloudflare → Variables
  const ttlSeconds = ttlHours * 60 * 60;

  // Cache key for tides: location bucket + date
  const cacheKey = new Request(
    `https://edge-cache.local/tides?lat=${rLat}&lon=${rLon}&date=${dateStr}`,
    { method: "GET" }
  );

  // 1) If we have cached tides, use them immediately
  const cached = await cache.match(cacheKey);
  if (cached) {
    debug.cache = `HIT (${ttlHours}h bucket)`;
    const payload = await cached.json();
    return {
      data: Array.isArray(payload?.data) ? payload.data : [],
      station: payload?.station ?? null,
      debug
    };
  }

  debug.cache = "MISS";

  // If no key, we can’t fetch — return empty
  if (!env?.STORMGLASS_API_KEY) {
    debug.note = "No STORMGLASS_API_KEY set";
    return { data: [], station: null, debug };
  }

  // Build Stormglass request (today + tomorrow range)
  const startISO = `${dateStr}T00:00:00+00:00`;
  const endDate = new Date(`${dateStr}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const endStr = endDate.toISOString().slice(0, 10);
  const endISO = `${endStr}T00:00:00+00:00`;

  const tideUrl =
    `https://api.stormglass.io/v2/tide/extremes/point` +
    `?lat=${lat}&lng=${lon}` +
    `&start=${encodeURIComponent(startISO)}` +
    `&end=${encodeURIComponent(endISO)}` +
    `&datum=MSL`;

  debug.url = tideUrl;

  try {
    const res = await fetch(tideUrl, {
      headers: { Authorization: env.STORMGLASS_API_KEY }
    });

    debug.status = res.status;

    const text = await res.text();
    debug.bodyPreview = text.slice(0, 180);

    // If quota/rate-limited, return empty (no cache exists yet)
    if (!res.ok) {
      throw new Error(`Upstream ${res.status}: ${text.slice(0, 160)}`);
    }

    const tideJson = JSON.parse(text);
    const data = Array.isArray(tideJson?.data) ? tideJson.data : [];
    const station = tideJson?.meta?.station ?? null;

    // 2) Store successful tides in edge cache
    const toCache = new Response(JSON.stringify({ data, station }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=0, s-maxage=${ttlSeconds}`
      }
    });
    // cache.put is async-safe without waitUntil; Pages will still perform it.
    cache.put(cacheKey, toCache);

    debug.cache = `STORE (${ttlHours}h)`;
    return { data, station, debug };
  } catch (e) {
    debug.error = String(e);
    return { data: [], station: null, debug };
  }
}

/* ---------------- Generic edge cache helpers ---------------- */

async function cachedFetchJson(url, ttlSeconds = 600) {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });

  const cached = await cache.match(key);
  if (cached) return cached.json();

  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${text.slice(0, 160)}`);

  const toCache = new Response(text, {
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
      "cache-control": `public, max-age=0, s-maxage=${ttlSeconds}`
    }
  });

  cache.put(key, toCache);
  return JSON.parse(text);
}

/* ---------------- Utilities ---------------- */

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
