export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);

  const lat = parseFloat(searchParams.get("lat"));
  const lon = parseFloat(searchParams.get("lon"));
  const dayOffset = parseInt(searchParams.get("day") || "0", 10);

  if (isNaN(lat) || isNaN(lon)) {
    return json({ error: "lat and lon are required" }, 400);
  }

  const date = new Date();
  date.setUTCDate(date.getUTCDate() + dayOffset);
  const dateStr = date.toISOString().split("T")[0];

  const result = {
    location: { lat, lon },
    date: dateStr
  };

  /* ---------- SUN (Sunrise / Sunset) ---------- */
  try {
    const sunRes = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`
    );
    const sunJson = await sunRes.json();
    result.sun = sunJson.results;
  } catch {
    result.sun = null;
  }

  /* ---------- UV INDEX (Open-Meteo) ---------- */
  try {
    const uvRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=uv_index_max&timezone=Australia/Brisbane`
    );
    const uvJson = await uvRes.json();
    result.uv = {
      max: uvJson.daily?.uv_index_max?.[0] ?? null
    };
  } catch {
    result.uv = null;
  }

  /* ---------- MOON PHASE ---------- */
 /* ---------- MOON PHASE (local, no API) ---------- */
result.moon = calcMoon(dateStr);

function calcMoon(dateStr) {
  // Approx synodic month model (good for utility display)
  const epoch = Date.UTC(2000, 0, 6, 18, 14, 0); // near new moon
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  const synodic = 29.530588853 * 86400000;

  let age = (t - epoch) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic; // 0..1

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


  /* ---------- TIDES (Stormglass – coastal only) ---------- */
 /* ---------- TIDES (Stormglass – coastal) ---------- */
if (env.STORMGLASS_API_KEY) {
  try {
    // Build a proper time window: YYYY-MM-DDT00 to next day YYYY-MM-DDT00
    const startISO = `${dateStr}T00`;
    const endDate = new Date(dateStr + "T00:00:00Z");
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const endStr = endDate.toISOString().slice(0, 10);
    const endISO = `${endStr}T00`;

    const tideUrl =
      `https://api.stormglass.io/v2/tide/extremes/point` +
      `?lat=${lat}&lng=${lon}&start=${encodeURIComponent(startISO)}` +
      `&end=${encodeURIComponent(endISO)}&datum=MSL`;

    const tideRes = await fetch(tideUrl, {
      headers: { Authorization: env.STORMGLASS_API_KEY }
    });

    if (!tideRes.ok) {
      const msg = await tideRes.text();
      result.tides = { available: false, error: msg.slice(0, 200) };
    } else {
      const tideJson = await tideRes.json();
      result.tides = tideJson.data ?? [];
      result.tideStation = tideJson.meta?.station ?? null;
    }
  } catch (e) {
    result.tides = { available: false, error: String(e) };
  }
} else {
  result.tides = { available: false };
}

