export async function onRequestGet() {
  return new Response("hello from root route", { status: 200 });
}
