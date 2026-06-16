# CUBIT — Production Deploy

Opinionated single-VPS deploy. Three long-running pieces + a static client:

| Piece | Process | Port | Fronted by |
|---|---|---|---|
| Game server | `hytopia run index.ts` (Bun) | 8080 (HTTPS + **WebTransport/HTTP3**) | **nothing** — direct |
| Auth backend | `bun server.ts` (Bun + SQLite) | 3001 | Caddy → `api.example.com` |
| Static client | built files | — | Caddy → `play.example.com` |

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
Point three records at your VPS IP:
- `play.example.com` → A/AAAA → VPS
- `api.example.com`  → A/AAAA → VPS
- `game.example.com` → A/AAAA → VPS  — **must be DNS-only** (if you use Cloudflare, **grey-cloud** it; the orange proxy kills WebTransport/UDP)

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

# Caddy (auto-TLS for play. + api.)
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit example.com → your domain
sudo systemctl reload caddy
```

### 5. Game-server TLS (the one SDK-specific step ⚠️)
The game server terminates TLS itself on :8080 for WebTransport. The bundled dev cert only works for `localhost`/`local.hytopiahosting.com`. For `game.example.com` you must give the SDK a **real cert** (Let's Encrypt):
```bash
sudo certbot certonly --standalone -d game.example.com   # → /etc/letsencrypt/live/game.example.com/
```
Then point the server's SSL at that cert/key. This is engine-internal (the HYTOPIA SDK / your `hytopia-source` server SSL config — see CLAUDE.md "Deploying to your own domain"). Verify with the client at `https://play.example.com/?join=game.example.com:8080` — DevTools → Network should show the `webtransport` connection succeed (not fall back to `ws`).

---

## Operations
- **Logs:** `journalctl -u cubit-game -f` · `journalctl -u cubit-backend -f`
- **Restart after deploy:** `git pull && bun install && bash deploy/build-client.sh && sudo systemctl restart cubit-backend cubit-game`
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
