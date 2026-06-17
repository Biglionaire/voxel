# CUBIT — Going to Mainnet (real USDC rewards)

The gold ↔ reward-token bridge runs on **devnet** today with a self-minted test-USDC.
Switching to **mainnet real USDC** means **real money leaves the treasury on every
withdrawal** — treat this as a financial + (possibly) regulatory step, not just a config change.

> ⚠️ **Legal:** real-money rewards / play-to-earn with stablecoins may trigger money-transmission,
> gambling, or KYC/AML rules in some jurisdictions. Get advice before launch. This doc is technical only.

---

## 1. Rotate the treasury key (do this first)

The devnet treasury secret was exposed during testing. **Generate a fresh keypair for mainnet**
and never print it to a terminal that's logged/shared:

```bash
# on the server, writes a keypair file readable only by root
solana-keygen new --no-bip39-passphrase -o /root/cubit-treasury-mainnet.json
solana-keygen pubkey /root/cubit-treasury-mainnet.json   # → the new treasury address
# convert to base58 for CUBIT_TREASURY_SECRET (or store the json path and load it)
```

Keep the secret **only** in the server `.env` (chmod 600) — never commit, never paste in chat.

## 2. Fund the treasury (real assets)

Send to the **new treasury address**:
- **USDC** — the reward pool you're willing to pay out (start small, e.g. $20–100). Top up as you grow.
- **SOL** — ~**1 SOL** for fees + recipient ATA rent (covers ~400–500 first-time withdrawers).

## 3. Flip the config (`/opt/cubit/deploy/.env`)

```bash
CUBIT_RPC=https://api.mainnet-beta.solana.com    # or a dedicated RPC (Helius/QuickNode) for production
REWARD_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # USDC (mainnet, 6 decimals)
REWARD_DECIMALS=6
REWARD_SYMBOL=USDC
CUBIT_TREASURY_SECRET=<new base58 secret>
FAUCET_ENABLED=false                              # NO faucet with real money
# tune the economy to your monthly budget:
REWARD_RATE=100000        # gold per 1 USDC (higher = stingier/scarcer)
REWARD_MIN_GOLD=50000     # min gold per withdraw
REWARD_DAILY_CAP=1        # max USDC / account / 24h
```
Then `sudo systemctl restart cubit-backend cubit-game`. **No code change needed.**

## 4. Tune the economy to a budget

Pick a monthly payout budget, then set `REWARD_RATE` so realistic net withdrawals ≈ budget.
Remember net = gold earned − gold spent in-game (sinks). Start conservative; loosen later.

| Goal | REWARD_RATE | 1000 gold = |
|---|---|---|
| Generous | 10,000 | $0.10 |
| Balanced | 100,000 | $0.01 |
| Very scarce | 1,000,000 | $0.001 |

## 5. Verify after switch

```bash
curl -s https://cubit.cash/api/cubit/info     # mint=USDC, symbol=USDC, faucet off
# do ONE tiny withdraw from a test wallet and confirm USDC arrives on mainnet (Solscan, no ?cluster).
```

## 6. Operate safely

- **Monitor** the treasury USDC + SOL balance; alert on fast drain.
- Keep `REWARD_DAILY_CAP` + `REWARD_MIN_GOLD` tight to start; relax once trust is established.
- Watch the `withdrawals` table for abuse patterns.
- `$CUBIT` (mainnet `9oA6TFkdpaStyWJqUkX5dCMQAktSM16rjLtS7Vgaory`, fixed 500K) stays a separate listed
  token — you can later add it as a second reward option or governance/utility layer.
