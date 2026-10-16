export const onRequestGet = ({ env }) =>
  new Response(JSON.stringify({ ok: true, service: 'shotful', browser: Boolean(env.BROWSER) }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
