# CUBIT — Production Deploy

Opinionated single-VPS deploy. Three long-running pieces + a static client:

| Piece | Process | Port | Fronted by |
|---|---|---|---|
| Game server | `hytopia run index.ts` (Bun) | 8080 (HTTPS + **WebTransport/HTTP3**) | **nothing** — direct |
| Auth backend / landing | `bun server.ts` (Bun + SQLite) | 3001 | Caddy → `cubit.cash` |
| Static client | built files | — | Caddy → `play.cubit.cash` |

> **Why a VPS, not a PaaS?** The game server speaks **WebTransport = HTTP/3 (QUIC over UDP/443-class)** and terminates **its own TLS** on :8080. Render/Railway/Heroku/Vercel/Fly-default only pass TCP/HTTP and can't proxy QUIC, so WebTransport breaks (falls back to slow WebSocket). You need a box with **UDP open + your own cert**. Recommended: **Hetzner CX22 (2 vCPU / 4 GB, ~€5/mo)** or any DigitalOcean/Vultr/Linode 4 GB droplet. (Game server idles ~850 MB RSS; 4 GB is comfortable, 2 GB is the floor.)

---

## What `git clone` ships — and what it doesn't (read this)

Your question: *"how do I make all the files come along on `git clone`?"*

**Everything needed is already tracked** — but big, regenerable things are intentionally **not** in git and are restored by the package manager. That's the correct, standard setup (committing them would bloat the repo to GBs and violate asset licensing).

| In git (ships on clone) | NOT in git (restored on the server) | How it's restored |
|---|---|---|
| `index.ts`, `backend/`, `assets/map.json`, `assets/ui/`, `backend/public/` | `node_modules/` | `bun install` |
| `package.json` + **`package-lock.json`** (the lockfile is what guarantees identical deps) | `assets/models,audio,blocks,…` (~3,300 HYTOPIA art assets) | `bun install` pulls `@hytopia.com/assets` |
| `tsconfig.json`, `deploy/`, `CLAUDE.md` | `index.mjs` (build output), `backend/data.sqlite*` (runtime DB) | built at run; DB created on first run |

So: **`git clone` + `bash deploy/setup.sh` = a complete, runnable server.** The lockfile is committed, so deps are reproducible.

Two things genuinely live **outside** this repo, by design — `setup.sh`/`build-client.sh` fetch them:
- **The bundled assets** come from npm (`@hytopia.com/assets`), not git.
- **The web client** is a separate MIT repo (`hytopia-source`) — `build-client.sh` clones & builds it.

> Want a fully self-contained clone with zero external fetch? You *can* delete the `assets/*` and `node_modules` lines from `.gitignore` and commit them — **not recommended** (repo bloat + the bundled art is under HYTOPIA's *Limited Use* license). Keep the lockfile approach.

---

## Step by step

### 0. DNS (do first)
Point your records at the VPS IP:
- `cubit.cash` + `www.cubit.cash` → A/AAAA → VPS  (backend / landing)
- `play.cubit.cash` → A/AAAA → VPS  (static client)
- `game.cubit.cash` → A/AAAA → VPS  — **must be DNS-only** (if you use Cloudflare, **grey-cloud** it; the orange proxy kills WebTransport/UDP)

Open firewall: TCP 80, 443 (Caddy) and **TCP + UDP 8080** (game server).

### 1. Get the code + toolchain
```bash
sudo useradd -m cubit && sudo su - cubit
git clone <your-repo-url> /opt/cubit && cd /opt/cubit
bash deploy/setup.sh          # installs Bun + toktx, runs bun install, creates deploy/.env
```

### 2. Configure
```bash
nano deploy/.env              # set CUBIT_SECRET (openssl rand -hex 32) + your domains
```

### 3. Build the client
```bash
bash deploy/build-client.sh   # clones hytopia-source, builds → /opt/cubit/client-dist
```

### 4. Services (as root)
```bash
sudo cp deploy/systemd/cubit-backend.service /etc/systemd/system/
sudo cp deploy/systemd/cubit-game.service    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cubit-backend cubit-game

# Caddy (auto-TLS for cubit.cash + play.cubit.cash)
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # already set for cubit.cash
sudo systemctl reload caddy
```

### 5. Game-server TLS — inject a real cert into the SDK (the SDK-specific step ⚠️)
The game server terminates TLS itself on :8080 for WebTransport, but the npm
`hytopia` SDK **hardcodes** a `*.hytopiahosting.com` cert (as string literals
`$k`/`Zk` in `node_modules/hytopia/server.mjs`), so browsers reject it on
`game.cubit.cash`. The Caddyfile's `game.cubit.cash` block makes Caddy obtain &
auto-renew a real Let's Encrypt cert; `inject-game-cert.js` swaps it into the SDK
(covers both the HTTPS/2 and WebTransport servers — they share `$k`/`Zk`):
```bash
node /opt/cubit/deploy/inject-game-cert.js     # patch server.mjs with the LE cert
sudo systemctl restart cubit-game
# Auto-renew: re-inject + restart only when Caddy renews the cert (daily check)
sudo cp deploy/systemd/cubit-cert-renew.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cubit-cert-renew.timer
```
Re-run `inject-game-cert.js` after any `bun install` (it restores the SDK file).
Verify: `echo | openssl s_client -connect game.cubit.cash:8080 -alpn h2 | openssl x509 -noout -subject` → `CN = game.cubit.cash`, `Verify return code: 0 (ok)`.

---

## Operations
- **Logs:** `journalctl -u cubit-game -f` · `journalctl -u cubit-backend -f`
- **Restart after deploy:** `git pull && bun install && node deploy/inject-game-cert.js && bash deploy/build-client.sh && sudo systemctl restart cubit-backend cubit-game` (the `inject` re-applies the game cert that `bun install` reverts)
- **Backups (critical — accounts live here):** the only state is `backend/data.sqlite`. With WAL on, checkpoint + copy:
  ```bash
  sqlite3 /opt/cubit/backend/data.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
  cp /opt/cubit/backend/data.sqlite /backups/cubit-$(date +%F).sqlite
  ```
  (Cron it daily.)

## Later: on-chain $CUBIT (Solana)
No infra change — the backend just needs a Solana **RPC endpoint** (Helius/QuickNode/public). The 1000-coin signup bonus + gold balance migrate to an on-chain $CUBIT balance then.

## Legal
Engine is MIT. The bundled **art assets are under HYTOPIA's Limited Use License** — review before a public launch.
