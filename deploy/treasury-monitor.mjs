// CUBIT treasury monitor — checks the live reward treasury's SOL + reward-token
// balance on-chain and prints a status line (WARN when below thresholds). Run by
// the cubit-treasury-monitor systemd timer; config comes from the running backend
// (/api/cubit/info → treasury + mint + network) so it follows future key rotations.
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

const BACKEND = process.env.CUBIT_BACKEND_URL ?? 'http://127.0.0.1:3001';
const RPC = process.env.CUBIT_RPC ?? 'https://api.mainnet-beta.solana.com';
const MIN_SOL = Number(process.env.MONITOR_MIN_SOL ?? 0.05);   // ~25 first-time ATAs left
const MIN_TOKEN = Number(process.env.MONITOR_MIN_USDC ?? 10);  // reward pool floor

const info = await (await fetch(`${BACKEND}/api/cubit/info`)).json();
if (!info?.treasury || !info?.mint) { console.log(`[treasury] ERROR: backend not configured (enabled=${info?.enabled})`); process.exit(2); }

const conn = new Connection(RPC, 'confirmed');
const treasury = new PublicKey(info.treasury);
const mint = new PublicKey(info.mint);
const sol = (await conn.getBalance(treasury)) / 1e9;
let token = 0;
try { const ata = await getAssociatedTokenAddress(mint, treasury); token = Number((await getAccount(conn, ata)).amount) / 10 ** (info.decimals ?? 6); } catch {}

const warns = [];
if (sol < MIN_SOL) warns.push(`SOL ${sol.toFixed(4)} < ${MIN_SOL} (top up — fees/ATA rent)`);
if (token < MIN_TOKEN) warns.push(`${info.symbol} ${token.toFixed(2)} < ${MIN_TOKEN} (reward pool low)`);
const tag = warns.length ? 'WARN' : 'OK';
console.log(`[treasury] ${tag} ${info.network} ${info.treasury} | ${info.symbol} ${token.toFixed(2)} | SOL ${sol.toFixed(4)}${warns.length ? ' | ' + warns.join('; ') : ''}`);
process.exit(warns.length ? 1 : 0);
