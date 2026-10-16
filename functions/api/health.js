/** GET /api/health — lightweight liveness check. */

export const onRequestGet = ({ env }) =>
  new Response(JSON.stringify({ ok: true, service: 'shotapi', browser: Boolean(env.BROWSER) }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
