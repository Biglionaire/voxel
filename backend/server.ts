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
import { createHmac, timingSafeEqual, verify as edVerify, createPublicKey, randomBytes } from 'crypto';
import { solanaEnabled, treasuryAddress, mintAddress, getCubitBalance, sendCubit, verifyDeposit } from './solana';

const isWalletName = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); // base58 Solana pubkey
const getProfileData = (username: string): any => { const row = db.query('SELECT data FROM profiles WHERE username = ?').get(username) as any; return row ? JSON.parse(row.data) : {}; };
const setProfileData = (username: string, data: any) => { const s = JSON.stringify(data); db.run('INSERT INTO profiles (username, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET data = ?, updated_at = ?', [username, s, Date.now(), s, Date.now()]); };

/* ---------------- Solana wallet auth (ed25519, no deps) ---------------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Buffer {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch); if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
function ed25519Verify(message: Buffer, sig: Buffer, pubRaw: Buffer): boolean {
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]); // SPKI prefix + 32-byte key
    return edVerify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), sig);
  } catch { return false; }
}
const walletMessage = (wallet: string, nonce: string) => `Sign in to CUBIT\n\nWallet: ${wallet}\nNonce: ${nonce}`;
const walletNonces = new Map<string, { nonce: string; exp: number }>();

const PORT = Number(process.env.PORT ?? 3001);
const SECRET = process.env.CUBIT_SECRET ?? 'dev-secret-change-me';
// Where to send players after login (the self-hosted client + local game server).
const GAME_URL = process.env.CUBIT_GAME_URL ?? 'http://localhost:5173/?join=local.hytopiahosting.com:8080';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ---------------- Database ---------------- */
const db = new Database('data.sqlite');
db.run('PRAGMA journal_mode = WAL');   // concurrent reads while writing — keeps autosave bursts fast
db.run('PRAGMA synchronous = NORMAL'); // safe with WAL; avoids fsync per write
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
db.run(`CREATE TABLE IF NOT EXISTS deposits (
  sig TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ts INTEGER NOT NULL
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

    // --- Solana wallet auth: step 1, request a nonce to sign ---
    if (pathname === '/api/wallet-nonce' && req.method === 'POST') {
      const { wallet } = await req.json().catch(() => ({}));
      if (!wallet || typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 48) return json({ error: 'Valid wallet required.' }, 400);
      const nonce = randomBytes(16).toString('hex');
      walletNonces.set(wallet, { nonce, exp: Date.now() + 5 * 60 * 1000 });
      return json({ message: walletMessage(wallet, nonce) });
    }

    // --- Solana wallet auth: step 2, verify the signature → token (creates account on first connect) ---
    if (pathname === '/api/wallet-verify' && req.method === 'POST') {
      const { wallet, signature } = await req.json().catch(() => ({}));
      const rec = wallet && walletNonces.get(wallet);
      if (!rec || rec.exp < Date.now()) return json({ error: 'Nonce expired — reconnect your wallet.' }, 400);
      let ok = false;
      try {
        const pub = b58decode(wallet);
        if (pub.length === 32) ok = ed25519Verify(Buffer.from(walletMessage(wallet, rec.nonce)), Buffer.from(String(signature ?? ''), 'base64'), pub);
      } catch { ok = false; }
      if (!ok) return json({ error: 'Signature verification failed.' }, 401);
      walletNonces.delete(wallet);
      const exists = db.query('SELECT 1 FROM users WHERE username = ?').get(wallet);
      if (!exists) db.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [wallet, 'wallet:' + wallet, Date.now()]);
      return json({ token: signToken(wallet), username: wallet, wallet, isNew: !exists });
    }

    // --- $CUBIT on-chain (Solana, custodial treasury) ---
    if (pathname === '/api/cubit/info') {
      return json({ enabled: solanaEnabled, mint: mintAddress(), treasury: treasuryAddress(), network: 'devnet', rate: 1, decimals: Number(process.env.CUBIT_DECIMALS ?? 9) });
    }
    if (pathname === '/api/cubit/balance') {
      const username = verifyToken(bearer(req));
      if (!username) return json({ error: 'Unauthorized.' }, 401);
      const pd = getProfileData(username);
      const gold = pd?.inventory?.['gold-ingot'] ?? 0;
      const cubit = isWalletName(username) ? await getCubitBalance(username) : 0;
      return json({ wallet: isWalletName(username) ? username : null, gold, cubit });
    }
    // Withdraw: burn in-game gold → send $CUBIT from the treasury to the player's wallet (1:1).
    if (pathname === '/api/cubit/withdraw' && req.method === 'POST') {
      const username = verifyToken(bearer(req));
      if (!username) return json({ error: 'Unauthorized.' }, 401);
      if (!isWalletName(username)) return json({ error: 'Connect with a Solana wallet to withdraw.' }, 400);
      if (!solanaEnabled) return json({ error: '$CUBIT is not configured yet.' }, 503);
      const { amount } = await req.json().catch(() => ({}));
      const amt = Math.floor(Number(amount));
      if (!(amt > 0)) return json({ error: 'Enter a valid amount.' }, 400);
      const pd = getProfileData(username);
      if (!pd.inventory) pd.inventory = {};
      const gold = pd.inventory['gold-ingot'] ?? 0;
      if (gold < amt) return json({ error: `Not enough gold (you have ${gold}).` }, 400);
      pd.inventory['gold-ingot'] = gold - amt; if (pd.inventory['gold-ingot'] <= 0) delete pd.inventory['gold-ingot'];
      setProfileData(username, pd); // debit first
      try {
        const sig = await sendCubit(username, amt);
        return json({ ok: true, sig, withdrawn: amt });
      } catch (e: any) {
        pd.inventory['gold-ingot'] = (pd.inventory['gold-ingot'] ?? 0) + amt; setProfileData(username, pd); // refund
        return json({ error: 'Transfer failed: ' + (e?.message || e) }, 500);
      }
    }

    // Deposit: verify a confirmed on-chain transfer of $CUBIT to the treasury → credit gold (1:1).
    if (pathname === '/api/cubit/deposit' && req.method === 'POST') {
      const username = verifyToken(bearer(req));
      if (!username) return json({ error: 'Unauthorized.' }, 401);
      if (!isWalletName(username)) return json({ error: 'Connect with a Solana wallet to deposit.' }, 400);
      if (!solanaEnabled) return json({ error: '$CUBIT not configured.' }, 503);
      const { sig } = await req.json().catch(() => ({}));
      if (!sig || typeof sig !== 'string') return json({ error: 'Missing transaction signature.' }, 400);
      if (db.query('SELECT 1 FROM deposits WHERE sig = ?').get(sig)) return json({ error: 'That deposit was already credited.' }, 400);
      const amount = await verifyDeposit(sig, username);
      if (!(amount > 0)) return json({ error: 'No valid $CUBIT deposit to the treasury found in that transaction.' }, 400);
      const gold = Math.floor(amount);
      db.run('INSERT INTO deposits (sig, username, amount, ts) VALUES (?, ?, ?, ?)', [sig, username, gold, Date.now()]);
      const pd = getProfileData(username); if (!pd.inventory) pd.inventory = {};
      pd.inventory['gold-ingot'] = (pd.inventory['gold-ingot'] ?? 0) + gold;
      setProfileData(username, pd);
      return json({ ok: true, credited: gold });
    }

    // Internal: the game server sends $CUBIT after it has already debited in-game gold.
    if (pathname === '/api/cubit/send' && req.method === 'POST') {
      const key = req.headers.get('x-internal-key');
      if (!process.env.CUBIT_INTERNAL_KEY || key !== process.env.CUBIT_INTERNAL_KEY) return json({ error: 'Forbidden.' }, 403);
      if (!solanaEnabled) return json({ error: '$CUBIT not configured.' }, 503);
      const { wallet, amount } = await req.json().catch(() => ({}));
      if (!isWalletName(wallet) || !(Number(amount) > 0)) return json({ error: 'Bad args.' }, 400);
      try { return json({ ok: true, sig: await sendCubit(wallet, Number(amount)) }); }
      catch (e: any) { return json({ error: String(e?.message || e) }, 500); }
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

    // --- Static assets from public/ (bg.png, favicon, …) ---
    if (/^\/[\w.-]+\.(png|jpe?g|webp|gif|svg|ico|css|js)$/.test(pathname)) {
      const f = Bun.file(`${import.meta.dir}/public${pathname}`);
      if (await f.exists()) return new Response(f, { headers: { 'Cache-Control': 'public, max-age=86400' } });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`🔐 CUBIT auth backend running at http://localhost:${PORT}`);
console.log(`   Landing → http://localhost:${PORT}/   ·   Game → ${GAME_URL}`);
if (SECRET === 'dev-secret-change-me') console.warn('⚠️  Using the default dev SECRET. Set CUBIT_SECRET in production.');
