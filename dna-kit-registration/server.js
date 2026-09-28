// DNA Kit Registration — zero-dependency Node.js server (Node 22+, built-in SQLite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ------------------------------------------------------------------ config */
const env = process.env;
const PORT = Number(env.PORT || 3000);
const DATA_DIR = env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const PUBLIC_URL = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : `http://localhost:${PORT}`)).replace(/\/$/, '');
const STRIPE_KEY = env.STRIPE_SECRET_KEY || '';
const STRIPE_WH = env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API = env.STRIPE_API_BASE || 'https://api.stripe.com';
const PRICE_MINOR = Math.round(Number(env.PRICE_AMOUNT || 0) * 100);
const CURRENCY = (env.CURRENCY || 'dkk').toLowerCase();
const PRODUCT_NAME = env.PRODUCT_NAME || 'DNA test';
const COMPANY = env.COMPANY_NAME || 'Our DNA testing service';
const PRIVACY_URL = env.PRIVACY_URL || '';
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- database */
const db = new DatabaseSync(path.join(DATA_DIR, 'kits.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kits (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dob TEXT NOT NULL,
  email TEXT, phone TEXT,
  sample_date TEXT,
  event TEXT,
  source TEXT NOT NULL DEFAULT 'self',
  consent_at TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TEXT NOT NULL,
  received_at TEXT,
  pay_status TEXT NOT NULL DEFAULT 'pending',
  pay_method TEXT,
  amount_minor INTEGER,
  currency TEXT,
  pay_ref TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  receipt_url TEXT,
  paid_at TEXT,
  notes TEXT,
  created_by INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kits_session ON kits(stripe_session_id);
CREATE INDEX IF NOT EXISTS kits_pi ON kits(stripe_payment_intent);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  code TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const now = () => new Date().toISOString();
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const audit = (userId, action, code, detail) => db.prepare('INSERT INTO audit(at,user_id,action,code,detail) VALUES(?,?,?,?,?)').run(now(), userId ?? null, action, code ?? null, detail ? String(detail).slice(0, 500) : null);

let SESSION_SECRET = env.SESSION_SECRET || getSetting('session_secret');
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', SESSION_SECRET); }

/* ------------------------------------------------------------- passwords */
function hashPw(pw) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(pw, salt, 64); return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`; }
function checkPw(pw, stored) {
  try { const [, s, h] = stored.split('$'); const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex')); } catch { return false; }
}
// First admin from env
if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0 && env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  db.prepare('INSERT INTO users(email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?)').run(env.ADMIN_EMAIL.trim(), env.ADMIN_NAME || 'Admin', hashPw(env.ADMIN_PASSWORD), 'admin', now());
  console.log('Created first admin user', env.ADMIN_EMAIL);
}

/* ------------------------------------------------------------- sessions */
const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeSession(uid) { const p = b64u(JSON.stringify({ uid, exp: Date.now() + 12 * 3600e3 })); return p + '.' + sign(p); }
function readSession(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s) return null;
  const good = sign(p); if (good.length !== s.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(s))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); if (o.exp < Date.now()) return null;
    const u = db.prepare('SELECT id,email,name,role,disabled FROM users WHERE id=?').get(o.uid); return u && !u.disabled ? u : null; } catch { return null; }
}
const cookie = (v, maxAge) => `sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIES ? '; Secure' : ''}`;

/* ------------------------------------------------------------- helpers */
const normCode = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_\-]/g, '').slice(0, 64);
const clean = (s, n = 200) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch { return null; } }

// naive in-memory rate limiter
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const t = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60_000).unref();
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

/* ------------------------------------------------------------- stripe */
function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
  }
  return out.join('&');
}
async function stripe(method, pathname, params) {
  const url = STRIPE_API + pathname + (method === 'GET' && params ? '?' + formEncode(params) : '');
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: method === 'GET' ? undefined : formEncode(params || {})
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error?.message || 'Stripe error'); e.stripe = j.error; throw e; }
  return j;
}
async function createCheckout(kit) {
  return stripe('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    client_reference_id: kit.code,
    customer_email: kit.email || undefined,
    line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY, unit_amount: PRICE_MINOR, product_data: { name: PRODUCT_NAME, description: 'Kit ' + kit.code } } } },
    metadata: { kit_code: kit.code },
    payment_intent_data: { metadata: { kit_code: kit.code }, description: `${PRODUCT_NAME} – kit ${kit.code}` },
    success_url: `${PUBLIC_URL}/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_URL}/?kit=${encodeURIComponent(kit.code)}&cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour
  });
}
// Apply a Checkout Session (from webhook or redirect) to the kit
async function applySession(session, via) {
  const code = normCode(session.client_reference_id || session.metadata?.kit_code);
  if (!code) return null;
  const kit = db.prepare('SELECT * FROM kits WHERE code=?').get(code);
  if (!kit) return null;
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    db.prepare('UPDATE kits SET stripe_session_id=?, updated_at=? WHERE code=?').run(session.id, now(), code);
    return { code, paid: false };
  }
  let receipt = null, pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  try {
    if (pi) { const p = await stripe('GET', `/v1/payment_intents/${pi}`, { 'expand[]': 'latest_charge' }); receipt = p.latest_charge?.receipt_url || null; }
  } catch (e) { console.warn('receipt lookup failed', e.message); }
  if (kit.pay_status !== 'paid') audit(null, 'paid', code, `Stripe ${via}: ${session.id}`);
  db.prepare(`UPDATE kits SET pay_status='paid', pay_method='Stripe', amount_minor=?, currency=?, stripe_session_id=?, stripe_payment_intent=?,
     pay_ref=COALESCE(?, pay_ref), receipt_url=COALESCE(?, receipt_url), paid_at=COALESCE(paid_at, ?), updated_at=? WHERE code=?`)
    .run(session.amount_total ?? kit.amount_minor, session.currency || CURRENCY, session.id, pi || null, pi || null, receipt, now(), now(), code);
  return { code, paid: true };
}
function verifyStripeSig(raw, header) {
  if (!STRIPE_WH || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = parts.t; if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WH).update(`${t}.${raw}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/* ------------------------------------------------------------- kit shape */
function kitOut(k) {
  if (!k) return null;
  return {
    code: k.code, name: k.name, dob: k.dob, email: k.email, phone: k.phone, sampleDate: k.sample_date, event: k.event,
    source: k.source, consentAt: k.consent_at, status: k.status, registeredAt: k.registered_at, receivedAt: k.received_at,
    payment: { status: k.pay_status, method: k.pay_method, amount: k.amount_minor != null ? k.amount_minor / 100 : null, currency: k.currency,
      ref: k.pay_ref, receiptUrl: k.receipt_url, paidAt: k.paid_at, stripeSession: k.stripe_session_id, stripePaymentIntent: k.stripe_payment_intent },
    notes: k.notes, updatedAt: k.updated_at
  };
}
function validatePerson(b) {
  const p = { name: clean(b.name, 120), dob: String(b.dob || ''), email: clean(b.email, 160).toLowerCase(), phone: clean(b.phone, 40) };
  const errs = [];
  if (p.name.length < 2) errs.push('full name');
  if (!isDate(p.dob) || p.dob > today() || p.dob < '1900-01-01') errs.push('date of birth');
  if (p.email && !isEmail(p.email)) errs.push('email address');
  return { p, errs };
}

/* ------------------------------------------------------------- static */
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SEC_HEADERS = {
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'",
  ...(SECURE_COOKIES ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
};
function serveFile(res, file) {
  const fp = path.join(PUB, file);
  if (!fp.startsWith(PUB) || !fs.existsSync(fp)) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', ...SEC_HEADERS });
  fs.createReadStream(fp).pipe(res);
}

/* ------------------------------------------------------------- routes */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // pages
  if (m === 'GET' && (p === '/' || p === '/register')) return serveFile(res, 'register.html');
  if (m === 'GET' && p === '/done') return serveFile(res, 'done.html');
  if (m === 'GET' && (p === '/staff' || p === '/staff/')) return serveFile(res, readSession(req) ? 'staff.html' : 'login.html');
  if (m === 'GET' && p === '/health') return send(res, 200, { ok: true });
  if (m === 'GET' && /^\/assets\/[\w.\-]+$/.test(p)) return serveFile(res, p.slice(1));

  // Stripe webhook (raw body)
  if (m === 'POST' && p === '/stripe/webhook') {
    const raw = (await readBody(req, 1_000_000)).toString('utf8');
    if (!verifyStripeSig(raw, req.headers['stripe-signature'])) return fail(res, 400, 'bad signature');
    let ev; try { ev = JSON.parse(raw); } catch { return fail(res, 400, 'bad json'); }
    try {
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) await applySession(ev.data.object, 'webhook');
      if (ev.type === 'charge.refunded') {
        const ch = ev.data.object; const code = normCode(ch.metadata?.kit_code);
        const row = code ? db.prepare('SELECT code FROM kits WHERE code=?').get(code) : db.prepare('SELECT code FROM kits WHERE stripe_payment_intent=?').get(ch.payment_intent);
        if (row && ch.refunded) { db.prepare("UPDATE kits SET pay_status='refunded', updated_at=? WHERE code=?").run(now(), row.code); audit(null, 'refunded', row.code, 'Stripe webhook'); }
      }
    } catch (e) { console.error('webhook handling error', e); return fail(res, 500, 'error'); }
    return send(res, 200, { received: true });
  }

  /* ---------------- public API ---------------- */
  if (p.startsWith('/api/public/')) {
    if (m === 'GET' && p === '/api/public/config') {
      return send(res, 200, { company: COMPANY, privacyUrl: PRIVACY_URL, event: getSetting('current_event') || '', stripe: !!(STRIPE_KEY && PRICE_MINOR > 0),
        price: PRICE_MINOR > 0 ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: CURRENCY.toUpperCase() }).format(PRICE_MINOR / 100) : null, product: PRODUCT_NAME });
    }
    if (m === 'POST' && p === '/api/public/check') {
      if (rateLimited('chk:' + ipOf(req), 60, 10 * 60e3)) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      const b = await readJson(req); const code = normCode(b?.code);
      if (code.length < 4) return fail(res, 400, 'That kit number looks too short.');
      const k = db.prepare('SELECT pay_status FROM kits WHERE code=?').get(code);
      return send(res, 200, { code, state: !k ? 'new' : (k.pay_status === 'pending' ? 'unpaid' : 'taken') });
    }
    if (m === 'POST' && p === '/api/public/register') {
      if (rateLimited('reg:' + ipOf(req), 20, 10 * 60e3)) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      const b = await readJson(req); if (!b) return fail(res, 400, 'Bad request');
      const code = normCode(b.code);
      if (code.length < 4) return fail(res, 400, 'Scan or type the kit number from the back of your card.');
      const { p: person, errs } = validatePerson(b);
      if (!person.email) errs.push('email address');
      if (errs.length) return fail(res, 400, 'Please check your ' + errs.join(', ') + '.');
      if (!b.consent) return fail(res, 400, 'Please tick the consent box to continue.');
      const existing = db.prepare('SELECT * FROM kits WHERE code=?').get(code);
      if (existing && existing.pay_status !== 'pending') return fail(res, 409, 'This kit is already registered. Please speak to a member of staff.');
      const t = now(); const ev = getSetting('current_event') || null;
      if (existing) {
        db.prepare('UPDATE kits SET name=?, dob=?, email=?, phone=?, consent_at=?, event=COALESCE(event, ?), updated_at=? WHERE code=?').run(person.name, person.dob, person.email, person.phone, t, ev, t, code);
        audit(null, 'self_update', code, 'Re-submitted before payment');
      } else {
        db.prepare(`INSERT INTO kits(code,name,dob,email,phone,sample_date,event,source,consent_at,status,registered_at,pay_status,updated_at)
          VALUES(?,?,?,?,?,?,?,'self',?,'registered',?,'pending',?)`).run(code, person.name, person.dob, person.email, person.phone, today(), ev, t, t, t);
        audit(null, 'self_register', code, ev ? 'Event: ' + ev : null);
      }
      if (!STRIPE_KEY || PRICE_MINOR <= 0) return send(res, 200, { code, checkoutUrl: null });
      try {
        const s = await createCheckout({ code, email: person.email });
        db.prepare('UPDATE kits SET stripe_session_id=?, updated_at=? WHERE code=?').run(s.id, now(), code);
        return send(res, 200, { code, checkoutUrl: s.url });
      } catch (e) { console.error('checkout error', e.message); return fail(res, 502, 'Your details are saved, but payment could not start. Please ask a member of staff.'); }
    }
    if (m === 'GET' && p === '/api/public/confirm') {
      const sid = String(url.searchParams.get('session_id') || '');
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return fail(res, 400, 'Missing payment reference');
      let result = null;
      const row = db.prepare('SELECT * FROM kits WHERE stripe_session_id=?').get(sid);
      if (STRIPE_KEY) { try { const s = await stripe('GET', `/v1/checkout/sessions/${sid}`); result = await applySession(s, 'redirect'); } catch (e) { console.warn('confirm lookup failed', e.message); } }
      const k = db.prepare('SELECT * FROM kits WHERE code=?').get(result?.code || row?.code || '');
      if (!k) return fail(res, 404, 'We could not find this registration. Please speak to a member of staff.');
      return send(res, 200, { code: k.code, firstName: k.name.split(' ')[0], paid: k.pay_status === 'paid', receiptUrl: k.receipt_url });
    }
    return fail(res, 404, 'Not found');
  }

  /* ---------------- auth ---------------- */
  if (m === 'POST' && p === '/api/login') {
    if (rateLimited('login:' + ipOf(req), 10, 10 * 60e3)) return fail(res, 429, 'Too many attempts. Wait 10 minutes.');
    const b = await readJson(req) || {};
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(clean(b.email, 160));
    if (!u || u.disabled || !checkPw(String(b.password || ''), u.pw_hash)) return fail(res, 401, 'Wrong email or password.');
    audit(u.id, 'login', null, ipOf(req));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(makeSession(u.id), 12 * 3600) });
  }
  if (m === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

  /* ---------------- staff API ---------------- */
  if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
  const user = readSession(req);
  if (!user) return fail(res, 401, 'Please sign in again.');
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'kit-app') return fail(res, 403, 'Bad request origin');
  const admin = user.role === 'admin';

  if (m === 'GET' && p === '/api/me') return send(res, 200, { id: user.id, email: user.email, name: user.name, role: user.role, event: getSetting('current_event') || '', stripe: !!(STRIPE_KEY && PRICE_MINOR > 0), stripeTest: /^(sk|rk)_test_/.test(STRIPE_KEY), price: PRICE_MINOR / 100, currency: CURRENCY });

  if (m === 'POST' && p === '/api/me/password') {
    const b = await readJson(req) || {};
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!checkPw(String(b.current || ''), u.pw_hash)) return fail(res, 400, 'Your current password is wrong.');
    if (String(b.next || '').length < 10) return fail(res, 400, 'Use at least 10 characters for the new password.');
    db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(String(b.next)), user.id); audit(user.id, 'password_change');
    return send(res, 200, { ok: true });
  }

  if (m === 'GET' && p === '/api/stats') {
    const ev = getSetting('current_event') || '';
    const q = (sql, ...a) => db.prepare(sql).get(...a).n;
    return send(res, 200, {
      event: ev,
      eventTotal: ev ? q('SELECT COUNT(*) n FROM kits WHERE event=?', ev) : 0,
      eventPaid: ev ? q("SELECT COUNT(*) n FROM kits WHERE event=? AND pay_status='paid'", ev) : 0,
      eventPending: ev ? q("SELECT COUNT(*) n FROM kits WHERE event=? AND pay_status='pending'", ev) : 0,
      total: q('SELECT COUNT(*) n FROM kits'),
      received: q("SELECT COUNT(*) n FROM kits WHERE status='received'"),
      transit: q("SELECT COUNT(*) n FROM kits WHERE status!='received'"),
      unpaid: q("SELECT COUNT(*) n FROM kits WHERE pay_status='pending'"),
      recent: db.prepare('SELECT * FROM kits ORDER BY registered_at DESC LIMIT 8').all().map(k => ({ code: k.code, name: k.name, registeredAt: k.registered_at, payStatus: k.pay_status, source: k.source }))
    });
  }

  if (m === 'PUT' && p === '/api/settings') {
    if (!admin) return fail(res, 403, 'Only admins can change settings.');
    const b = await readJson(req) || {};
    setSetting('current_event', clean(b.event, 120)); audit(user.id, 'set_event', null, clean(b.event, 120));
    return send(res, 200, { ok: true });
  }

  if (m === 'GET' && (p === '/api/kits' || p === '/api/kits.csv')) {
    const qs = url.searchParams; const where = []; const args = [];
    const q = clean(qs.get('q'), 100); const ev = clean(qs.get('event'), 120); const f = qs.get('filter');
    if (q) { where.push('(code LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ?)'); const like = '%' + q + '%'; args.push(like, like, like, like); }
    if (ev) { where.push('event=?'); args.push(ev); }
    if (f === 'transit') where.push("status!='received'");
    if (f === 'received') where.push("status='received'");
    if (f === 'unpaid') where.push("pay_status='pending'");
    const sql = 'SELECT * FROM kits' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY registered_at DESC' + (p.endsWith('.csv') ? '' : ' LIMIT 500');
    const rows = db.prepare(sql).all(...args);
    if (p.endsWith('.csv')) {
      audit(user.id, 'export_csv', null, `${rows.length} rows`);
      const head = ['Kit code', 'Full name', 'Date of birth', 'Sample date', 'Event', 'Email', 'Phone', 'Registered by', 'Payment status', 'Method', 'Amount', 'Currency', 'Reference', 'Receipt', 'Registered', 'Received at lab', 'Notes'];
      const csvRows = rows.map(k => [k.code, k.name, k.dob, k.sample_date, k.event, k.email, k.phone, k.source, k.pay_status, k.pay_method, k.amount_minor != null ? k.amount_minor / 100 : '', k.currency, k.pay_ref, k.receipt_url, k.registered_at, k.received_at, k.notes]);
      const csv = '﻿' + [head, ...csvRows].map(r => r.map(v => { v = String(v ?? ''); if (/^[=@\t\r]|^[+\-](?![\d\s()]+$)/.test(v)) v = "'" + v; return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="dna-kits-${today()}.csv"` });
    }
    const events = db.prepare("SELECT DISTINCT event FROM kits WHERE event IS NOT NULL AND event <> '' ORDER BY event").all().map(r => r.event);
    return send(res, 200, { kits: rows.map(kitOut), events, total: db.prepare('SELECT COUNT(*) n FROM kits').get().n });
  }

  if (m === 'POST' && p === '/api/kits') {
    const b = await readJson(req) || {};
    const code = normCode(b.code); if (code.length < 4) return fail(res, 400, 'Scan the kit barcode first.');
    const { p: person, errs } = validatePerson(b);
    if (errs.length) return fail(res, 400, 'Check the ' + errs.join(', ') + '.');
    if (db.prepare('SELECT 1 FROM kits WHERE code=?').get(code)) return fail(res, 409, 'This kit is already registered.');
    const t = now(); const pay = b.payment || {}; const ps = ['paid', 'pending', 'comp', 'refunded'].includes(pay.status) ? pay.status : 'pending';
    db.prepare(`INSERT INTO kits(code,name,dob,email,phone,sample_date,event,source,consent_at,status,registered_at,pay_status,pay_method,amount_minor,currency,pay_ref,paid_at,notes,created_by,updated_at)
      VALUES(?,?,?,?,?,?,?,'staff',?,'registered',?,?,?,?,?,?,?,?,?,?)`).run(code, person.name, person.dob, person.email, person.phone, isDate(b.sampleDate) ? b.sampleDate : today(),
      getSetting('current_event') || null, b.consent ? t : null, t, ps, clean(pay.method, 40) || null, pay.amount != null && pay.amount !== '' ? Math.round(Number(pay.amount) * 100) : null,
      CURRENCY, clean(pay.ref, 80) || null, ps === 'paid' ? t : null, clean(b.notes, 500) || null, user.id, t);
    audit(user.id, 'staff_register', code);
    return send(res, 200, { kit: kitOut(db.prepare('SELECT * FROM kits WHERE code=?').get(code)) });
  }

  const km = /^\/api\/kits\/([A-Za-z0-9_\-]{1,64})(\/[a-z\-]+)?$/.exec(p);
  if (km) {
    const code = normCode(km[1]); const sub = km[2] || '';
    const k = db.prepare('SELECT * FROM kits WHERE code=?').get(code);
    if (m === 'GET' && !sub) { if (!k) return fail(res, 404, 'No kit found'); audit(user.id, 'view', code); return send(res, 200, { kit: kitOut(k) }); }
    if (!k) return fail(res, 404, 'No kit found');
    if (m === 'PATCH' && !sub) {
      const b = await readJson(req) || {}; const t = now();
      if (b.action === 'receive') { db.prepare("UPDATE kits SET status='received', received_at=?, updated_at=? WHERE code=?").run(t, t, code); audit(user.id, 'received', code); }
      else if (b.action === 'unreceive') { db.prepare("UPDATE kits SET status='registered', received_at=NULL, updated_at=? WHERE code=?").run(t, code); audit(user.id, 'unreceived', code); }
      else if (b.action === 'mark_paid') { db.prepare("UPDATE kits SET pay_status='paid', pay_method=COALESCE(?, pay_method), pay_ref=COALESCE(?, pay_ref), paid_at=COALESCE(paid_at, ?), updated_at=? WHERE code=?").run(clean(b.method, 40) || null, clean(b.ref, 80) || null, t, t, code); audit(user.id, 'mark_paid', code, b.method); }
      else if (b.action === 'edit') {
        const { p: person, errs } = validatePerson(b); if (errs.length) return fail(res, 400, 'Check the ' + errs.join(', ') + '.');
        const pay = b.payment || {}; const ps = ['paid', 'pending', 'comp', 'refunded'].includes(pay.status) ? pay.status : k.pay_status;
        db.prepare(`UPDATE kits SET name=?, dob=?, email=?, phone=?, sample_date=?, notes=?, pay_status=?, pay_method=?, amount_minor=?, pay_ref=?, paid_at=?, updated_at=? WHERE code=?`)
          .run(person.name, person.dob, person.email, person.phone, isDate(b.sampleDate) ? b.sampleDate : k.sample_date, clean(b.notes, 500) || null, ps, clean(pay.method, 40) || k.pay_method,
            pay.amount != null && pay.amount !== '' ? Math.round(Number(pay.amount) * 100) : k.amount_minor, clean(pay.ref, 80) || k.pay_ref, ps === 'paid' ? (k.paid_at || t) : k.paid_at, t, code);
        audit(user.id, 'edit', code);
      } else return fail(res, 400, 'Unknown action');
      return send(res, 200, { kit: kitOut(db.prepare('SELECT * FROM kits WHERE code=?').get(code)) });
    }
    if (m === 'POST' && sub === '/checkout') {
      if (!STRIPE_KEY || PRICE_MINOR <= 0) return fail(res, 400, 'Stripe is not set up yet.');
      try { const s = await createCheckout(k); db.prepare('UPDATE kits SET stripe_session_id=?, updated_at=? WHERE code=?').run(s.id, now(), code); audit(user.id, 'checkout_link', code); return send(res, 200, { url: s.url }); }
      catch (e) { return fail(res, 502, 'Stripe error: ' + e.message); }
    }
    if (m === 'POST' && sub === '/sync') {
      if (!STRIPE_KEY || !k.stripe_session_id) return fail(res, 400, 'No Stripe payment to check for this kit.');
      try { const s = await stripe('GET', `/v1/checkout/sessions/${k.stripe_session_id}`); await applySession(s, 'staff check'); return send(res, 200, { kit: kitOut(db.prepare('SELECT * FROM kits WHERE code=?').get(code)) }); }
      catch (e) { return fail(res, 502, 'Stripe error: ' + e.message); }
    }
    if (m === 'DELETE' && !sub) {
      if (!admin) return fail(res, 403, 'Only admins can delete records.');
      db.prepare('DELETE FROM kits WHERE code=?').run(code); audit(user.id, 'delete', code, k.name);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && sub === '/history') {
      const rows = db.prepare('SELECT a.at, a.action, a.detail, u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.code=? ORDER BY a.id DESC LIMIT 50').all(code);
      return send(res, 200, { history: rows });
    }
    return fail(res, 404, 'Not found');
  }

  /* users (admin) */
  if (p === '/api/users' && m === 'GET') {
    if (!admin) return fail(res, 403, 'Admins only');
    return send(res, 200, { users: db.prepare('SELECT id,email,name,role,disabled,created_at FROM users ORDER BY created_at').all() });
  }
  if (p === '/api/users' && m === 'POST') {
    if (!admin) return fail(res, 403, 'Admins only');
    const b = await readJson(req) || {}; const email = clean(b.email, 160).toLowerCase(); const name = clean(b.name, 80);
    if (!isEmail(email) || !name) return fail(res, 400, 'Enter a name and a valid email.');
    if (String(b.password || '').length < 10) return fail(res, 400, 'Use at least 10 characters for the password.');
    try { db.prepare('INSERT INTO users(email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?)').run(email, name, hashPw(String(b.password)), b.role === 'admin' ? 'admin' : 'staff', now()); }
    catch { return fail(res, 409, 'A user with that email already exists.'); }
    audit(user.id, 'user_add', null, email); return send(res, 200, { ok: true });
  }
  const um = /^\/api\/users\/(\d+)$/.exec(p);
  if (um && m === 'PATCH') {
    if (!admin) return fail(res, 403, 'Admins only');
    const id = Number(um[1]); const b = await readJson(req) || {};
    if (id === user.id && b.disabled) return fail(res, 400, "You can't disable your own account.");
    if (typeof b.disabled === 'boolean') db.prepare('UPDATE users SET disabled=? WHERE id=?').run(b.disabled ? 1 : 0, id);
    if (b.password) { if (String(b.password).length < 10) return fail(res, 400, 'Use at least 10 characters.'); db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(String(b.password)), id); }
    audit(user.id, 'user_update', null, String(id)); return send(res, 200, { ok: true });
  }

  return fail(res, 404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, e.message === 'too_large' ? 413 : 500, 'Something went wrong. Please try again.'); });
}).listen(PORT, () => console.log(`DNA kit app on ${PORT} (${PUBLIC_URL}) data=${DATA_DIR} stripe=${STRIPE_KEY ? 'on' : 'off'}`));
