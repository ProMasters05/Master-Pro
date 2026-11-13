'use strict';
/**
 * Vercel serverless function: confirms a Stripe Checkout purchase.
 *
 *   GET /api/verify?session_id=cs_...&n=<browser nonce>
 *
 * Required environment variables (Vercel > Project > Settings > Environment Variables):
 *   STRIPE_SECRET_KEY   sk_live_... (or sk_test_... for testing). Never put this in the browser.
 *   PLINK_SINGLE        the Payment Link ID for the single master ($3.99)  (plink_...)
 *   PLINK_MONTHLY       the Payment Link ID for Pro Monthly
 *   PLINK_YEARLY        the Payment Link ID for Pro Yearly
 *   PLINK_LIFETIME      the Payment Link ID for Pro Lifetime
 *
 * Single masters are one-time: the first browser to redeem a purchase "claims" it by writing its
 * nonce onto the PaymentIntent metadata. The same browser can retry safely; any other browser is refused.
 */
const STRIPE = 'https://api.stripe.com/v1';

function kindFor(session, env) {
  const raw = session.payment_link;
  const id = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.id : null);
  if (!id) return null;
  const map = { single: env.PLINK_SINGLE, monthly: env.PLINK_MONTHLY, yearly: env.PLINK_YEARLY, lifetime: env.PLINK_LIFETIME };
  for (const [kind, plink] of Object.entries(map)) if (plink && plink === id) return kind;
  return null;
}

async function stripe(method, path, body, env, fetchImpl) {
  const res = await fetchImpl(STRIPE + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(body).toString() : undefined
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON error */ }
  return { status: res.status, json };
}

async function verify({ sessionId, nonce }, env, fetchImpl = globalThis.fetch) {
  if (!env.STRIPE_SECRET_KEY) return { status: 500, body: { ok: false, reason: 'server_not_configured' } };
  if (typeof sessionId !== 'string' || !/^cs_(test_|live_)?[A-Za-z0-9]{10,}$/.test(sessionId)) return { status: 400, body: { ok: false, reason: 'bad_session' } };
  if (nonce !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce))) return { status: 400, body: { ok: false, reason: 'bad_nonce' } };

  const q = '?expand[]=payment_intent&expand[]=payment_intent.latest_charge&expand[]=subscription';
  const r = await stripe('GET', '/checkout/sessions/' + sessionId + q, null, env, fetchImpl);
  if (r.status === 404) return { status: 200, body: { ok: false, reason: 'not_found' } };
  if (r.status !== 200 || !r.json) return { status: 502, body: { ok: false, reason: 'stripe_error' } };

  const s = r.json;
  if (s.status !== 'complete') return { status: 200, body: { ok: false, reason: 'not_complete' } };
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { status: 200, body: { ok: false, reason: 'not_paid' } };

  const kind = kindFor(s, env);
  if (!kind) return { status: 200, body: { ok: false, reason: 'unknown_product' } };

  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  if (charge && charge.refunded) return { status: 200, body: { ok: false, reason: 'refunded' } };

  if (kind === 'monthly' || kind === 'yearly') {
    const sub = s.subscription && typeof s.subscription === 'object' ? s.subscription : null;
    if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) return { status: 200, body: { ok: false, reason: 'subscription_inactive' } };
  }

  if (kind === 'single') {
    if (!pi) return { status: 200, body: { ok: false, reason: 'missing_payment_intent' } };
    if (!nonce) return { status: 400, body: { ok: false, reason: 'bad_nonce' } };
    const claimed = pi.metadata && pi.metadata.mp_redeemed;
    if (claimed && claimed !== nonce) return { status: 200, body: { ok: false, reason: 'already_redeemed' } };
    if (!claimed) {
      const w = await stripe('POST', '/payment_intents/' + pi.id, { 'metadata[mp_redeemed]': nonce }, env, fetchImpl);
      if (w.status !== 200) return { status: 502, body: { ok: false, reason: 'could_not_record' } };
    }
  }
  return { status: 200, body: { ok: true, kind, livemode: !!s.livemode } };
}

/* Setup check (no secrets returned): GET /api/verify?check=1 */
function setupCheck(env) {
  const key = env.STRIPE_SECRET_KEY || '';
  const mode = /^(sk|rk)_live_/.test(key) ? 'live' : /^(sk|rk)_test_/.test(key) ? 'test' : key ? 'unrecognized' : 'missing';
  const env_ = { STRIPE_SECRET_KEY: !!key, PLINK_SINGLE: !!env.PLINK_SINGLE, PLINK_MONTHLY: !!env.PLINK_MONTHLY, PLINK_YEARLY: !!env.PLINK_YEARLY, PLINK_LIFETIME: !!env.PLINK_LIFETIME };
  const ready = Object.values(env_).every(Boolean) && mode !== 'missing' && mode !== 'unrecognized';
  return { ready, stripe_mode: mode, env: env_ };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, reason: 'method_not_allowed' }); }
  try {
    const q = req.query || {};
    if (q.check === '1') return res.status(200).json(setupCheck(process.env));
    const out = await verify({ sessionId: q.session_id, nonce: q.n }, process.env);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
};
module.exports.verify = verify;
module.exports.setupCheck = setupCheck;
