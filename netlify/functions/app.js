// Netlify serverless entry: wraps the same Express app (no route changes).
process.env.RUN_CRON = 'false'; // scheduler never runs inside a function; external cron hits /cron/run
process.env.NODE_ENV = process.env.NODE_ENV || 'production'; // set in code: marking it a secret env var trips Netlify's secret scanner (the word appears in source)
const crypto = require('crypto');
const serverless = require('serverless-http');
const app = require('../../src/app');

// Optional preview gate (HTTP Basic) in front of everything. Active only when
// PREVIEW_GATE_USER and PREVIEW_GATE_PASS are set (demo/preview deployments).
function gate(event) {
  const u = process.env.PREVIEW_GATE_USER, p = process.env.PREVIEW_GATE_PASS;
  if (!u || !p) return null;
  const h = event.headers && (event.headers.authorization || event.headers.Authorization) || '';
  const ok = h.startsWith('Basic ') && (() => {
    const [eu, ep] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/);
    const a = Buffer.from(String(eu) + ':' + String(ep)), b = Buffer.from(u + ':' + p);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  })();
  if (ok) return null;
  return { statusCode: 401, headers: { 'WWW-Authenticate': 'Basic realm="kayan-preview"', 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Preview access required' };
}

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  const blocked = gate(event);
  if (blocked) return blocked;
  return handler(event, context);
};
