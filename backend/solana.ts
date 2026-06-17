/**
 * $CUBIT on-chain (Solana, custodial treasury). Reads wallet balances and sends
 * $CUBIT from the treasury on withdrawal. Config via env (see deploy/.env):
 *   CUBIT_RPC, CUBIT_MINT, CUBIT_DECIMALS, CUBIT_TREASURY_SECRET
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, getAccount, transfer } from '@solana/spl-token';
import bs58 from 'bs58';

const RPC = process.env.CUBIT_RPC ?? 'https://api.devnet.solana.com';
const MINT = process.env.CUBIT_MINT ?? '';
const DECIMALS = Number(process.env.CUBIT_DECIMALS ?? 9);
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

/** Treasury → wallet transfer of `amount` $CUBIT. Returns the tx signature. */
export async function sendCubit(wallet: string, amount: number): Promise<string> {
  if (!treasury || !mint) throw new Error('Solana not configured');
  if (!isPubkey(wallet)) throw new Error('Invalid wallet');
  if (!(amount > 0)) throw new Error('Invalid amount');
  const fromAta = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
  const toAta = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, new PublicKey(wallet));
  return await transfer(conn, treasury, fromAta.address, toAta.address, treasury, BigInt(Math.round(amount * UNIT)));
}
