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
  try {
    const moonRes = await fetch(
      `https://api.farmsense.net/v1/moonphases/?d=${Math.floor(
        date.getTime() / 1000
      )}`
    );
    const moonJson = await moonRes.json();
    result.moon = moonJson[0];
  } catch {
    result.moon = null;
  }

  /* ---------- TIDES (Stormglass – coastal only) ---------- */
  if (env.STORMGLASS_API_KEY) {
    try {
      const tideRes = await fetch(
        `https://api.stormglass.io/v2/tide/extremes/point?lat=${lat}&lng=${lon}&start=${dateStr}&end=${dateStr}`,
        {
          headers: {
            Authorization: env.STORMGLASS_API_KEY
          }
        }
      );
      const tideJson = await tideRes.json();
      result.tides = tideJson.data ?? [];
    } catch {
      result.tides = { available: false };
    }
  } else {
    result.tides = { available: false };
  }

  return json(result);
}

/* ---------- helper ---------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300"
    }
  });
}
