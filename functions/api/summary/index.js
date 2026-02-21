async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Number(searchParams.get("day") || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat and lon are required" }, 400);
  }

  // Build a date string for "today + day" in UTC (good enough for API date key)
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + day);
  const dateStr = d.toISOString().slice(0, 10);

  const result = {
    location: { lat, lon },
    date: dateStr
  };

  // ---------- SUN (keep full data but add local HH:MM) ----------
  try {
    const sunRes = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`
    );
    const sunJson = await sunRes.json();
    const sun = sunJson?.results || null;

    result.sun = sun;

    // Add simple, user-friendly local time strings using Open-Meteo timezone
    const tz = await getTimezone(lat, lon);
    result.tz = tz;

    if (sun?.sunrise && sun?.sunset) {
      const sunriseUtc = new Date(sun.sunrise);
      const sunsetUtc = new Date(sun.sunset);

      result.sunLocal = {
        sunrise: fmtHHMM(sunriseUtc, tz),
        sunset: fmtHHMM(sunsetUtc, tz),
        dayLength: secondsToHM(sun.day_length)
      };
    }
  } catch (e) {
    result.sun = null;
  }

  // ---------- UV (Open-Meteo) ----------
  try {
    const tz = result.tz || "Australia/Brisbane";
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set("timezone", tz);
    u.searchParams.set("start_date", dateStr);
    u.searchParams.set("end_date", dateStr);
    u.searchParams.set("daily", "uv_index_max");

    const uvRes = await fetch(u.toString());
    const uvJson = await uvRes.json();

    result.uv = { max: uvJson?.daily?.uv_index_max?.[0] ?? null };
  } catch {
    result.uv = { max: null };
  }

  // ---------- MOON (local calc - never null) ----------
  result.moon = calcMoon(dateStr);

  // ---------- TIDES (Stormglass + DEBUG) ----------
  result.tides = [];
  result.tides_debug = { enabled: Boolean(env && env.STORMGLASS_API_KEY) };

  if (env && env.STORMGLASS_API_KEY) {
    try {
      // IMPORTANT: real time window (start < end)
      const startISO = `${dateStr}T00`;
      const endDate = new Date(`${dateStr}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 2);
      const endStr = endDate.toISOString().slice(0, 10);
      const endISO = `${endStr}T00`;

      const tideUrl =
        `https://api.stormglass.io/v2/tide/extremes/point` +
        `?lat=${lat}&lng=${lon}` +
        `&start=${encodeURIComponent(startISO)}` +
        `&end=${encodeURIComponent(endISO)}` +
        `&datum=MSL`;

      const tideRes = await fetch(tideUrl, {
        headers: { Authorization: env.STORMGLASS_API_KEY }
      });

      result.tides_debug.url = tideUrl;
      result.tides_debug.status = tideRes.status;

      const text = await tideRes.text();
      result.tides_debug.bodyPreview = text.slice(0, 250);

      // parse if JSON
      let tideJson = null;
      try { tideJson = JSON.parse(text); } catch {}

      if (tideRes.ok && tideJson) {
        result.tides = tideJson.data ?? [];
        result.tideStation = tideJson.meta?.station ?? null;
      } else {
        result.tides = [];
      }
    } catch (e) {
      result.tides_debug.error = String(e);
      result.tides = [];
    }
  }

  return json(result, 200, {
    "cache-control": "no-store" // disable caching while we debug
  });
}

module.exports = { onRequestGet };

/* ---------------- helpers ---------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

async function getTimezone(lat, lon) {
  try {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set("timezone", "auto");
    u.searchParams.set("current", "temperature_2m"); // tiny payload

    const r = await fetch(u.toString());
    const j = await r.json();
    return j.timezone || "Australia/Brisbane";
  } catch {
    return "Australia/Brisbane";
  }
}

function fmtHHMM(date, tz) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function secondsToHM(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return null;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function calcMoon(dateStr) {
  const epoch = Date.UTC(2000, 0, 6, 18, 14, 0); // near new moon
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  const synodic = 29.530588853 * 86400000;

  let age = (t - epoch) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic;

  const illuminationPct = Math.round((1 - Math.cos(2 * Math.PI * frac)) / 2 * 100);

  const phase = (() => {
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
  })();

  return { phase, illuminationPct };
}
