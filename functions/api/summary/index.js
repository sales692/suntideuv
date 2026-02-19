export async function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      message: "API route is working"
    }),
    {
      headers: {
        "content-type": "application/json"
      }
    }
  );
}
