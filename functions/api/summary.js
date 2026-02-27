export async function onRequestGet(context) {
  const { request, env } = context;
  const { searchParams } = new URL(request.url);

  const latRaw = Number(searchParams.get("lat"));
  const lonRaw = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) {
    return json({ ok: false, error: "lat and lon are required" }, 400);
  }

  // Build date string (UTC) for "today + day"
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + day);
  const dateStr = d.toISOString().slice(0, 10);

  const result = {
    ok: true,
    location: { lat: latRaw, lon: lonRaw },
    date: dateStr,
    sun: null,
    uv: { max: null },
    moon: calcMoon(dateStr),
    tides: [],
    tideStation: null,
    tides_debug: { enabled: Boolean(env?.STORMGLASS_API_KEY) },
  };

  // ---- SUN (cached 12 hours) ----
  try {
    const sunUrl =
      `https://api.sunrise-sunset.org/json?lat=${latRaw}&lng=${lonRaw}` +
      `&date=${encodeURIComponent(dateStr)}` +
      `&formatted=0`;

    const sunJson = await cachedFetchJson(context, sunUrl, {
      cacheTtlSeconds: 12 * 60 * 60,
    });

    result.sun = sunJson?.results ?? null;
  } catch {
    result.sun = null;
  }

  // ---- UV (cached 1 hour) ----
  try {
    const uvUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${latRaw}&longitude=${lonRaw}` +
      `&daily=uv_index_max&timezone=auto`;

    const uvJson = await cachedFetchJson(context, uvUrl, {
      cacheTtlSeconds: 60 * 60,
    });

    // IMPORTANT: pick the right day index
    result.uv.max = uvJson?.daily?.uv_index_max?.[day] ?? null;
  } catch {
    result.uv.max = null;
  }

  // ---- TIDES (Stormglass) ----
  // Quota protection:
  // 1) Only fetch tides for TODAY (day=0)
  // 2) Round coords to reduce cache fragmentation
  // 3) Enforce a daily global limit using KV
  if (day === 0 && env?.STORMGLASS_API_KEY) {
    const tideCacheHours = Number(env?.TIDE_CACHE_HOURS || 12);
    const dailyLimit = Number(env?.STORMGLASS_DAILY_LIMIT || 8);

    // ✅ rounding reduces unique URLs enormously
    const lat = Math.round(latRaw * 100) / 100;
    const lon = Math.round(lonRaw * 100) / 100;

    try {
      // ---- Daily KV throttle ----
      // Requires KV binding named env.KV
      const kv = env?.KV;
      if (!kv) {
        result.tides_debug.error = "KV binding missing (env.KV). Add KV binding named 'KV'.";
      } else {
        const todayKey = `stormglass:${dateStr}:count`;
        const current = Number((await kv.get(todayKey)) || 0);

        result.tides_debug.dailyLimit = dailyLimit;
        result.tides_debug.requestCount = current;

        if (current >= dailyLimit) {
          // hard stop: don't call Stormglass
          result.tides_debug.error = `Stormglass daily limit reached (${current}/${dailyLimit}).`;
        } else {
          // increment and set expiry (~2 days)
          await kv.put(todayKey, String(current + 1), { expirationTtl: 2 * 24 * 60 * 60 });

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

          // Cache Stormglass response at Cloudflare edge
          const tideText = await cachedFetchText(context, tideUrl, {
            cacheTtlSeconds: tideCacheHours * 60 * 60,
            headers: { Authorization: env.STORMGLASS_API_KEY },
          });

          result.tides_debug.url = tideUrl;
          result.tides_debug.cachedHours = tideCacheHours;

          const tideJson = JSON.parse(tideText);

          result.tides = Array.isArray(tideJson?.data) ? tideJson.data : [];
          result.tideStation = tideJson?.meta?.station ?? null;
        }
      }
    } catch (e) {
      // If Stormglass fails/quota exceeded, return empty tides but keep page working
      result.tides = [];
      result.tideStation = null;
      result.tides_debug.error = String(e);
    }
  }

  // Cache the summary response briefly so refreshes don't hammer APIs
  return json(result, 200, {
    "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
  });
}

/* ----------------- Cloudflare edge cache helpers ----------------- */

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
        "cache-control": `public, max-age=0, s-maxage=${cacheTtlSeconds}`,
      },
    });
    context.waitUntil(cache.put(cacheKey, toCache));
  }

  if (!res.ok) {
    throw new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`);
  }

  return text;
}

async function cachedFetchJson(context, url, opts = {}) {
  const text = await cachedFetchText(context, url, opts);
  return JSON.parse(text);
}

/* ----------------- utilities ----------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
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
