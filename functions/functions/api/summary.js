export async function onRequestGet({ request, env }) {
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
    tides_debug: { enabled: Boolean(env?.STORMGLASS_API_KEY) }
  };

  // SUN
  try {
    const sunRes = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`
    );
    const sunJson = await sunRes.json();
    result.sun = sunJson?.results ?? null;
  } catch {
    result.sun = null;
  }

  // UV
  try {
    const uvRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=uv_index_max&timezone=auto`
    );
    const uvJson = await uvRes.json();
    result.uv.max = uvJson?.daily?.uv_index_max?.[0] ?? null;
  } catch {
    result.uv.max = null;
  }

  // TIDES (Stormglass) + debug
  if (env?.STORMGLASS_API_KEY) {
    try {
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

      try {
        const tideJson = JSON.parse(text);
        if (tideRes.ok) {
          result.tides = tideJson.data ?? [];
          result.tideStation = tideJson.meta?.station ?? null;
        }
      } catch {
        // ignore JSON parse errors
      }
    } catch (e) {
      result.tides_debug.error = String(e);
    }
  }

  return json(result, 200, { "cache-control": "no-store" });
}

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
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...headers
    }
  });
}
export async function onRequestOptions() {
  return json({ ok: true }, 204);
}
const startISO = `${dateStr}T00`;
const endISO = `${endStr}T00`;
const startISO = `${dateStr}T00:00:00Z`;
const endISO = `${endStr}T00:00:00Z`;
