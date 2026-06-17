/**
 * One-time: create the $CUBIT SPL token on Solana devnet.
 * Generates a treasury keypair, airdrops devnet SOL, mints the token + supply.
 * Prints CUBIT_MINT and CUBIT_TREASURY_SECRET to paste into deploy/.env.
 *   bun run backend/solana-setup.ts
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import bs58 from 'bs58';

const conn = new Connection(clusterApiUrl('devnet'), 'confirmed');
const DECIMALS = 9;
const SUPPLY = 1_000_000_000n; // 1 billion $CUBIT

const treasury = Keypair.generate();
console.log('Treasury pubkey:', treasury.publicKey.toBase58());

// Airdrop SOL for fees (retry — public devnet faucet is flaky).
let funded = false;
for (let i = 0; i < 5 && !funded; i++) {
  try {
    const sig = await conn.requestAirdrop(treasury.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    funded = true;
    console.log('Airdropped 1 SOL ✓');
  } catch (e) { console.log(`airdrop attempt ${i + 1} failed, retrying…`); await new Promise(r => setTimeout(r, 3000)); }
}
if (!funded) { console.error('AIRDROP FAILED — fund the treasury pubkey with devnet SOL and re-run.'); process.exit(1); }

const mint = await createMint(conn, treasury, treasury.publicKey, treasury.publicKey, DECIMALS);
console.log('Mint ($CUBIT):', mint.toBase58());

const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
await mintTo(conn, treasury, mint, ata.address, treasury, SUPPLY * 10n ** BigInt(DECIMALS));
console.log(`Minted ${SUPPLY.toLocaleString()} $CUBIT to treasury ✓`);

console.log('\n==== paste into deploy/.env (KEEP THE SECRET PRIVATE) ====');
console.log(`CUBIT_RPC=https://api.devnet.solana.com`);
console.log(`CUBIT_MINT=${mint.toBase58()}`);
console.log(`CUBIT_DECIMALS=${DECIMALS}`);
console.log(`CUBIT_TREASURY_SECRET=${bs58.encode(treasury.secretKey)}`);
