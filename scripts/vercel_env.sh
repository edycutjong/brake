#!/usr/bin/env bash
# Push the runtime secrets from ~/.config/brake to the linked Vercel project (production). Values go through stdin — never
# echoed, never written into the tree. Run from apps/web after `vercel link`. Usage: scripts/vercel_env.sh <public-url>
set -euo pipefail
PUBLIC_URL=${1:?usage: vercel_env.sh https://<project>.vercel.app}
D="$HOME/.config/brake"
set -a; source "$D/wallets.env"; source "$D/app.env"; [ -f "$D/neon.env" ] && source "$D/neon.env"; [ -f "$D/cron.env" ] && source "$D/cron.env"; set +a
[ -f "$D/anthropic.key" ] && ANTHROPIC_API_KEY=$(tr -d '[:space:]' < "$D/anthropic.key")
put() { printf %s "${!1}" | vercel env add "$1" production --force >/dev/null && echo "set $1"; }
DEPLOYMENT=live BRAKE_MODEL=${BRAKE_MODEL:-anthropic} DAILY_SPEND_CAP_UNITS=${DAILY_SPEND_CAP_UNITS:-20000000} PUBLIC_URL=$PUBLIC_URL
for v in DEPLOYMENT BRAKE_MODEL DAILY_SPEND_CAP_UNITS PUBLIC_URL DATABASE_URL DEMO_PAYER_PRIVATE_KEY AGENT_PRIVATE_KEY KEEPER_PRIVATE_KEY \
         SIG_ENC_KEY PAYEES_MNEMONIC CRON_SECRET ANTHROPIC_API_KEY; do
  if [ -n "${!v:-}" ]; then export "$v"; put "$v"; else echo "skip $v (not set)"; fi
done
