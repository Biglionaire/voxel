/**
 * $CUBIT on-chain (Solana, custodial treasury). Reads wallet balances and sends
 * $CUBIT from the treasury on withdrawal. Config via env (see deploy/.env):
 *   CUBIT_RPC, CUBIT_MINT, CUBIT_DECIMALS, CUBIT_TREASURY_SECRET
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, getAccount, transfer } from '@solana/spl-token';
import bs58 from 'bs58';

const RPC = process.env.CUBIT_RPC ?? 'https://api.devnet.solana.com';
const MINT = process.env.REWARD_MINT ?? process.env.CUBIT_MINT ?? ''; // the payout token (USDC/$CUBIT)
const DECIMALS = Number(process.env.REWARD_DECIMALS ?? process.env.CUBIT_DECIMALS ?? 9);
const SECRET = process.env.CUBIT_TREASURY_SECRET ?? '';

const conn = new Connection(RPC, 'confirmed');
const mint = MINT ? new PublicKey(MINT) : null;
const treasury = SECRET ? Keypair.fromSecretKey(bs58.decode(SECRET)) : null;
const UNIT = 10 ** DECIMALS;

export const solanaEnabled = !!(mint && treasury);
export const treasuryAddress = () => treasury?.publicKey.toBase58() ?? null;
export const mintAddress = () => MINT;

const isPubkey = (s: string) => { try { new PublicKey(s); return true; } catch { return false; } };

/** A wallet's on-chain $CUBIT balance (0 if no token account yet). */
export async function getCubitBalance(wallet: string): Promise<number> {
  if (!mint || !isPubkey(wallet)) return 0;
  try {
    const ata = await getAssociatedTokenAddress(mint, new PublicKey(wallet));
    const acc = await getAccount(conn, ata);
    return Number(acc.amount) / UNIT;
  } catch { return 0; }
}

/** Verify a confirmed tx that sent $CUBIT from `fromWallet` to the treasury.
 * Returns the amount received by the treasury (0 if invalid). */
export async function verifyDeposit(sig: string, fromWallet: string): Promise<number> {
  if (!treasury || !mint || !isPubkey(fromWallet)) return 0;
  try {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || tx.meta?.err) return 0;
    const mintStr = mint.toBase58(), treas = treasury.publicKey.toBase58();
    const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
    const bal = (arr: any[], owner: string) => { const e = arr.find((b: any) => b.mint === mintStr && b.owner === owner); return e ? Number(e.uiTokenAmount?.uiAmount ?? 0) : 0; };
    const received = bal(post, treas) - bal(pre, treas);
    const sent = bal(pre, fromWallet) - bal(post, fromWallet);
    if (received > 0 && sent > 0 && Math.abs(received - sent) < 1e-6) return received;
    return 0;
  } catch { return 0; }
}

/** Treasury → wallet transfer of `amount` $CUBIT. Returns the tx signature. */
export async function sendCubit(wallet: string, amount: number): Promise<string> {
  if (!treasury || !mint) throw new Error('Solana not configured');
  if (!isPubkey(wallet)) throw new Error('Invalid wallet');
  if (!(amount > 0)) throw new Error('Invalid amount');
  const fromAta = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
  const toAta = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, new PublicKey(wallet));
  return await transfer(conn, treasury, fromAta.address, toAta.address, treasury, BigInt(Math.round(amount * UNIT)));
}
