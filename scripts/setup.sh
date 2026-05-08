#!/usr/bin/env bash
# ScrumMaster bot server bootstrap.
# Idempotent: safe to re-run. Run from repo root.
#
# Usage:
#   bash scripts/setup.sh                # interactive
#   PUBLIC_URL=https://x.example.com bash scripts/setup.sh --register-webhook
#
# Options:
#   --register-webhook   call Telegram setWebhook with $PUBLIC_URL
#   --install-launchd    install + load launchd agent for the bot server (macOS)
#   --skip-build         skip "npm run build"
#   --no-color           disable ANSI color output

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

REGISTER_WEBHOOK=0
INSTALL_LAUNCHD=0
SKIP_BUILD=0
USE_COLOR=1

for arg in "$@"; do
  case "$arg" in
    --register-webhook) REGISTER_WEBHOOK=1 ;;
    --install-launchd) INSTALL_LAUNCHD=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-color) USE_COLOR=0 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [[ $USE_COLOR -eq 1 && -t 1 ]]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_RST=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_RST=""
fi

info()  { printf "%s[*]%s %s\n" "$C_INFO" "$C_RST" "$*"; }
ok()    { printf "%s[✓]%s %s\n" "$C_OK"   "$C_RST" "$*"; }
warn()  { printf "%s[!]%s %s\n" "$C_WARN" "$C_RST" "$*" >&2; }
fail()  { printf "%s[✗]%s %s\n" "$C_ERR"  "$C_RST" "$*" >&2; exit 1; }

# 1. Prerequisites
info "checking prerequisites…"
command -v node >/dev/null || fail "node not found in PATH"
command -v npm  >/dev/null || fail "npm not found in PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "node >= 20 required (have $(node -v))"
ok "node $(node -v), npm $(npm -v)"

# 2. .env
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    warn ".env created from .env.example — fill in JIRA_* and TELEGRAM_BOT_TOKEN before continuing"
  else
    fail ".env and .env.example both missing"
  fi
else
  ok ".env present"
fi

# 3. Generate webhook secret if blank
if ! grep -q '^TELEGRAM_WEBHOOK_SECRET=..*' .env; then
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  if grep -q '^TELEGRAM_WEBHOOK_SECRET=' .env; then
    # macOS sed needs '' after -i; use perl for portability
    perl -i -pe "s|^TELEGRAM_WEBHOOK_SECRET=.*|TELEGRAM_WEBHOOK_SECRET=$SECRET|" .env
  else
    printf '\nTELEGRAM_WEBHOOK_SECRET=%s\n' "$SECRET" >> .env
  fi
  ok "TELEGRAM_WEBHOOK_SECRET generated"
else
  ok "TELEGRAM_WEBHOOK_SECRET already set"
fi

# 4. config.yaml
if [[ ! -f config.yaml ]]; then
  if [[ -f config.yaml.example ]]; then
    cp config.yaml.example config.yaml
    warn "config.yaml created from example — review project keys"
  else
    fail "config.yaml and example both missing"
  fi
else
  ok "config.yaml present"
fi

# 5. Install dependencies
info "installing npm dependencies…"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
ok "dependencies installed"

# 6. Type check
info "running typecheck…"
npm run typecheck >/dev/null
ok "typecheck passed"

# 7. Build
if [[ $SKIP_BUILD -eq 0 ]]; then
  info "building dist/…"
  npm run build >/dev/null
  ok "build complete"
fi

# 8. Subscriptions
mkdir -p data
if [[ ! -f data/subscriptions.json ]]; then
  info "no subscriptions yet — running migration from config.yaml…"
  npm run migrate-subscriptions
  ok "subscriptions initialized"
else
  ok "data/subscriptions.json present"
fi

# 9. Verify Jira + Telegram bot reachable
info "running connectivity check (npm run check)…"
if npm run check >/dev/null 2>&1; then
  ok "Jira + Telegram OK"
else
  warn "npm run check failed — verify JIRA_* and TELEGRAM_BOT_TOKEN in .env"
fi

# 10. Register webhook (optional)
if [[ $REGISTER_WEBHOOK -eq 1 ]]; then
  [[ -n "${PUBLIC_URL:-}" ]] || fail "PUBLIC_URL env var required with --register-webhook"
  info "registering Telegram webhook with $PUBLIC_URL…"
  npm run set-webhook -- "$PUBLIC_URL"
  ok "webhook registered"
fi

# 11. Install launchd agent (optional, macOS only)
if [[ $INSTALL_LAUNCHD -eq 1 ]]; then
  if [[ "$(uname)" != "Darwin" ]]; then
    warn "--install-launchd skipped: not macOS"
  else
    PLIST_SRC="$REPO_DIR/launchd/com.scrum.bot.plist"
    PLIST_DST="$HOME/Library/LaunchAgents/com.scrum.bot.plist"
    [[ -f "$PLIST_SRC" ]] || fail "missing $PLIST_SRC"
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    ok "launchd agent loaded ($PLIST_DST)"
    info "tail logs: tail -f $REPO_DIR/launchd/scrum-bot.out.log"
  fi
fi

echo
ok "setup complete"
echo
echo "Next steps:"
echo "  • Expose the bot publicly (Cloudflare Tunnel / ngrok / nginx) on the URL configured for the webhook."
echo "  • Register the webhook:  PUBLIC_URL=https://… bash scripts/setup.sh --register-webhook"
echo "  • Run server manually:   npm run server"
echo "  • Or install as agent:   bash scripts/setup.sh --install-launchd"
echo "  • In a Telegram group, type /project to manage subscriptions."
