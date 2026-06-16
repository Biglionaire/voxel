/**
 * CUBIT — auth & profile backend.
 *
 * Self-contained: Bun.serve + bun:sqlite + Bun.password (no external deps, no DB to install).
 * Provides account signup/login (HMAC-signed tokens) and per-user game-data persistence,
 * plus a landing page. The game server (index.ts) will verify these tokens to identify
 * players and load/save their inventory, gold & progress.
 *
 * Run:  cd backend && bun server.ts        (serves on http://localhost:3001)
 */

import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'crypto';

const PORT = Number(process.env.PORT ?? 3001);
const SECRET = process.env.CUBIT_SECRET ?? 'dev-secret-change-me';
// Where to send players after login (the self-hosted client + local game server).
const GAME_URL = process.env.CUBIT_GAME_URL ?? 'http://localhost:5173/?join=local.hytopiahosting.com:8080';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ---------------- Database ---------------- */
const db = new Database('data.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS profiles (
  username TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

/* ---------------- Tokens (HMAC, no deps) ---------------- */
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString();
const hmac = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64url');

function signToken(username: string): string {
  const body = b64url(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${hmac(body)}`;
}
function verifyToken(token: string | null): string | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(unb64url(body));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload.u as string;
  } catch { return null; }
}

/* ---------------- Helpers ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const bearer = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
const validName = (u: any) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
const validPass = (p: any) => typeof p === 'string' && p.length >= 6 && p.length <= 100;

/* ---------------- Server ---------------- */
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/health') return json({ ok: true });

    // --- Signup ---
    if (pathname === '/api/signup' && req.method === 'POST') {
      const { username, password } = await req.json().catch(() => ({}));
      if (!validName(username)) return json({ error: 'Username must be 3-20 chars (letters, numbers, _).' }, 400);
      if (!validPass(password)) return json({ error: 'Password must be at least 6 characters.' }, 400);
      const exists = db.query('SELECT 1 FROM users WHERE username = ?').get(username);
      if (exists) return json({ error: 'Username already taken.' }, 409);
      const hash = await Bun.password.hash(password);
      db.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [username, hash, Date.now()]);
      return json({ token: signToken(username), username });
    }

    // --- Login ---
    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await req.json().catch(() => ({}));
      const row = db.query('SELECT password_hash FROM users WHERE username = ?').get(username) as any;
      if (!row || !(await Bun.password.verify(String(password ?? ''), row.password_hash))) {
        return json({ error: 'Invalid username or password.' }, 401);
      }
      return json({ token: signToken(username), username });
    }

    // --- Who am I (token check) ---
    if (pathname === '/api/me') {
      const username = verifyToken(bearer(req));
      return username ? json({ username }) : json({ error: 'Invalid or expired token.' }, 401);
    }

    // --- Load / save profile (game data) ---
    if (pathname === '/api/profile') {
      const username = verifyToken(bearer(req));
      if (!username) return json({ error: 'Unauthorized.' }, 401);
      if (req.method === 'GET') {
        const row = db.query('SELECT data FROM profiles WHERE username = ?').get(username) as any;
        return json({ username, data: row ? JSON.parse(row.data) : {} });
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const data = JSON.stringify(body?.data ?? {});
        db.run('INSERT INTO profiles (username, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET data = ?, updated_at = ?',
          [username, data, Date.now(), data, Date.now()]);
        return json({ ok: true });
      }
    }

    // --- Redirect into the game with the token ---
    if (pathname === '/play') {
      const token = url.searchParams.get('token') ?? '';
      const sep = GAME_URL.includes('?') ? '&' : '?';
      return Response.redirect(`${GAME_URL}${sep}sessionToken=${encodeURIComponent(token)}`, 302);
    }

    // --- Static landing page ---
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(Bun.file(`${import.meta.dir}/public/index.html`), { headers: { 'Content-Type': 'text/html' } });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`🔐 CUBIT auth backend running at http://localhost:${PORT}`);
console.log(`   Landing → http://localhost:${PORT}/   ·   Game → ${GAME_URL}`);
if (SECRET === 'dev-secret-change-me') console.warn('⚠️  Using the default dev SECRET. Set CUBIT_SECRET in production.');
