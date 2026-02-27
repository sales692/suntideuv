export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }

  // Build date string (UTC)
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

  /* ---------- SUN (12h cache) ---------- */
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}` +
      `&date=${encodeURIComponent(dateStr)}&formatted=0`;

    const sunJson = await cachedFetchJson(
      sunUrl,
      { cacheTtlSeconds: 12 * 60 * 60 },
      waitUntil
    );

    result.sun = sunJson?.results ?? null;
  } catch {
    result.sun = null;
  }

  /* ---------- UV (1h cache) ---------- */
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&timezone=auto`;

    const uvJson = await cachedFetchJson(
      uvUrl,
      { cacheTtlSeconds: 60 * 60 },
      waitUntil
    );

    result.uv.max = uvJson?.daily?.uv_index_max?.[day] ?? null;
  } catch {
    result.uv.max = null;
  }

  /* ---------- TIDES (Stormglass, day 0 only) ---------- */
  if (day === 0 && env?.STORMGLASS_API_KEY) {
    const tideCacheHours = Number(env.TIDE_CACHE_HOURS || 6);

    try {
      const startISO = `${dateStr}T00:00:00+00:00`;
      const endDate = new Date(`${dateStr}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 2);
      const endISO = `${endDate.toISOString().slice(0, 10)}T00:00:00+00:00`;

      const tideUrl =
        `https://api.stormglass.io/v2/tide/extremes/point` +
        `?lat=${lat}&lng=${lon}` +
        `&start=${encodeURIComponent(startISO)}` +
        `&end=${encodeURIComponent(endISO)}` +
        `&datum=MSL`;

      const tideText = await cachedFetchText(
        tideUrl,
        {
          cacheTtlSeconds: tideCacheHours * 60 * 60,
          headers: { Authorization: env.STORMGLASS_API_KEY }
        },
        waitUntil
      );

      result.tides_debug.url = tideUrl;
      result.tides_debug.cachedHours = tideCacheHours;

      const tideJson = JSON.parse(tideText);
      result.tides = Array.isArray(tideJson?.data) ? tideJson.data : [];
      result.tideStation = tideJson?.meta?.station ?? null;

    } catch (e) {
      result.tides = [];
      result.tideStation = null;
      result.tides_debug.error = String(e);
    }
  }

  return json(result, 200, {
    "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600"
  });
}

/* ----------------- Edge cache helpers ----------------- */

async function cachedFetchText(url, opts = {}, waitUntil) {
  const cacheTtlSeconds = Number(opts.cacheTtlSeconds || 600);
  const headers = opts.headers || {};

  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });

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

    if (typeof waitUntil === "function") {
      waitUntil(cache.put(cacheKey, toCache));
    }
  }

  if (!res.ok) {
    throw new Error(`Upstream ${res.status}: ${text.slice(0, 160)}`);
  }

  return text;
}

async function cachedFetchJson(url, opts = {}, waitUntil) {
  const text = await cachedFetchText(url, opts, waitUntil);
  return JSON.parse(text);
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
