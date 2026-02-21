async function onRequestGet() {
  return new Response("hello", { status: 200 });
}
module.exports = { onRequestGet };
