#!/usr/bin/env bash
# Re-inject the game cert into the SDK + restart the game ONLY when Caddy has
# renewed it (avoids needless world restarts). Run daily via systemd timer.
set -e
CRT=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/game.cubit.cash/game.cubit.cash.crt
MARK=/opt/cubit/deploy/.game-cert.sha
[ -f "$CRT" ] || exit 0
NEW=$(sha256sum "$CRT" | awk '{print $1}')
[ "$NEW" = "$(cat "$MARK" 2>/dev/null)" ] && exit 0
/usr/bin/node /opt/cubit/deploy/inject-game-cert.js
systemctl restart cubit-game
echo "$NEW" > "$MARK"
logger -t cubit-cert 're-injected renewed game.cubit.cash cert; game restarted'
