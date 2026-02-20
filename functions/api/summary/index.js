module.exports = { onRequestGet };
  const BUILD = "BUILD-2026-02-20-001";
export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const day = Math.min(1, Math.max(0, Number(searchParams.get("day") || 0))); // 0 today, 1 tomorrow

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat and lon are required" }, 400);
  }

  // Australia bounding box sanity check (optional but helpful)
  if (lat < -45 || lat > -9 || lon < 110 || lon > 155) {
    return json({ error: "Location appears outside Australia" }, 400);
  }

  // Get timezone for the exact point (Open-Meteo, no key)
  const tz = await getTimezone(lat, lon);

  // Compute the local date we are returning (today or tomorrow, in that tz)
  const baseLocal = toZonedDate(new Date(), tz);
  baseLocal.setDate(baseLocal.getDate() + day);
  const dateStr = `${baseLocal.getFullYear()}-${pad2(baseLocal.getMonth() + 1)}-${pad2(baseLocal.getDate())}`;

  const out = {
    location: { lat, lon },
    date: dateStr,
    tz
  };

  // SUN: use sunrise-sunset.org but convert UTC timestamps to local HH:MM
  out.sun = await getSunLocal(lat, lon, tz);

  // UV: Open-Meteo daily max (and later we can add protection window)
  out.uv = await getUvMax(lat, lon, tz, dateStr);

  // MOON: local calculation (reliable, no API)
  out.moon = calcMoon(dateStr);

  // TIDES: Stormglass extremes with a proper time window
  out.tides = await getTides(lat, lon, dateStr, tz, env?.STORMGLASS_API_KEY);

  return json(out, 200, { "cache-control": "public, max-age=600" }); // 10 min cache
}

/* ---------------- helpers ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
      result.build = BUILD;
    }
  });
}

function pad2(n) { return String(n).padStart(2, "0"); }

async function getTimezone(lat, lon) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("current", "temperature_2m"); // tiny payload, but ensures timezone
  const r = await fetch(u.toString());
  if (!r.ok) return "Australia/Brisbane";
  const j = await r.json();
  return j.timezone || "Australia/Brisbane";
}

function toZonedDate(date, tz) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (t) => parts.find(p => p.type === t)?.value;
  return new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`);
}

function fmtHHMM(date, tz) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

async function getSunLocal(lat, lon, tz) {
  const r = await fetch(`https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j?.results) return null;

  const sunriseUtc = new Date(j.results.sunrise);
  const sunsetUtc  = new Date(j.results.sunset);

  // Keep original fields if you ever want them, but include user-friendly times:
  return {
    sunrise: fmtHHMM(sunriseUtc, tz),
    sunset: fmtHHMM(sunsetUtc, tz),
    dayLength: secondsToHM(j.results.day_length)
  };
}

function secondsToHM(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return null;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function getUvMax(lat, lon, tz, dateStr) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("timezone", tz);
  u.searchParams.set("start_date", dateStr);
  u.searchParams.set("end_date", dateStr);
  u.searchParams.set("daily", "uv_index_max");
  const r = await fetch(u.toString());
  if (!r.ok) return { max: null };
  const j = await r.json();
  return { max: j?.daily?.uv_index_max?.[0] ?? null };
}

function calcMoon(dateStr) {
  const epoch = Date.UTC(2000, 0, 6, 18, 14, 0); // near new moon
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  const synodic = 29.530588853 * 86400000;

  let age = (t - epoch) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic;

  const illuminationPct = Math.round((1 - Math.cos(2 * Math.PI * frac)) / 2 * 100);
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

async function getTides(lat, lon, dateStr, tz, apiKey) {
  if (!apiKey) return { available: false, note: "Missing STORMGLASS_API_KEY" };

  // Stormglass expects a time window like YYYY-MM-DDTHH. Use 36h to ensure all extremes.
  const startISO = `${dateStr}T00`;

  const endDate = new Date(`${dateStr}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const endStr = endDate.toISOString().slice(0, 10);
  const endISO = `${endStr}T12`;

  const tideUrl =
    `https://api.stormglass.io/v2/tide/extremes/point` +
    `?lat=${lat}&lng=${lon}&start=${encodeURIComponent(startISO)}` +
    `&end=${encodeURIComponent(endISO)}&datum=MSL`;

  const r = await fetch(tideUrl, {
    headers: { Authorization: apiKey }
  });

  if (!r.ok) {
    const msg = await r.text();
    return { available: false, note: `Stormglass error ${r.status}`, detail: msg.slice(0, 200) };
  }

  const j = await r.json();
  const station = j?.meta?.station ?? null;

  // Convert tide times to local and keep only entries matching dateStr
  const data = (j?.data ?? []).map(x => {
    const local = toZonedDate(new Date(x.time), tz);
    const dkey = `${local.getFullYear()}-${pad2(local.getMonth()+1)}-${pad2(local.getDate())}`;
    return {
      type: (x.type || "").toLowerCase() === "high" ? "High" : "Low",
      time: `${pad2(local.getHours())}:${pad2(local.getMinutes())}`,
      heightM: (typeof x.height === "number") ? x.height : null,
      dateKey: dkey
    };
  });

  const today = data.filter(x => x.dateKey === dateStr);

  if (!today.length) {
    // If no same-day extremes, return a helpful note
    return { available: false, station, note: "No tide extremes found for this date/location." };
  }

  return { available: true, station, today };
}
module.exports = { onRequestGet };
