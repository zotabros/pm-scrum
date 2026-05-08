# Deploy on aaPanel — first-time setup

CI/CD pattern: GitHub Actions self-hosted runner (already on the box) → build →
rsync into `/www/wwwroot/scrum.dzapp.io.vn` → `pm2 reload`. No SSH secrets in
GitHub. After the one-time setup below, every push to `main` deploys itself.

## 0. Prerequisites on the server

Run these as the **deploy** user (not root):

```bash
# Node 20 — install via aaPanel Software Store → "Node.js Version Manager"
node -v   # must be >= 20
npm -v

# PM2 globally for the deploy user
npm install -g pm2

# pm2 startup script (registers a systemd unit so PM2 auto-starts on reboot)
pm2 startup systemd -u deploy --hp /home/deploy
# pm2 prints a `sudo env ...` command — run it once as root.
```

## 1. Share the existing self-hosted runner with `pm-scrum`

The runner is currently registered to a different `zotabros/*` repo. Easiest fix
is to **promote it to org-level** so all repos can use it:

1. https://github.com/organizations/zotabros/settings/actions/runners → **New runner** → copy the registration token.
2. SSH to the box → into the existing runner directory (probably `~/actions-runner`).
3. Stop and re-register:
   ```bash
   ./svc.sh stop
   ./config.sh remove --token <DEREGISTRATION_TOKEN_FROM_OLD_REPO>
   ./config.sh --url https://github.com/zotabros --token <NEW_ORG_TOKEN> \
     --labels self-hosted,linux --unattended
   ./svc.sh install deploy
   ./svc.sh start
   ```
4. In `https://github.com/zotabros/pm-scrum/settings/actions` → Runners → confirm the runner is visible.

If you'd rather not promote, register a **second** runner instance (own folder,
own service) bound to `zotabros/pm-scrum` only.

## 2. Create the site in aaPanel

1. **Website → Add Site**: domain `scrum.dzapp.io.vn`, root `/www/wwwroot/scrum.dzapp.io.vn`, no DB, no FTP.
2. **SSL → Let's Encrypt**: issue cert.
3. **Config**: replace the `server` blocks with `deploy/nginx.conf.example` from this repo. Save → Reload nginx.

## 3. Permissions

The runner runs as user `deploy`. It needs ownership of the deploy dir:

```bash
sudo mkdir -p /www/wwwroot/scrum.dzapp.io.vn
sudo chown -R deploy:deploy /www/wwwroot/scrum.dzapp.io.vn
```

## 4. Bootstrap secrets (one-time)

CI never touches `.env` or `config.yaml`. Set them up once:

```bash
cd /www/wwwroot/scrum.dzapp.io.vn
# After the first GH Actions run, code is already here. If not, clone manually.
cp .env.example .env
$EDITOR .env       # JIRA_*, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ADMIN_USER_IDS
$EDITOR config.yaml
chmod 600 .env
```

Generate a strong webhook secret:
```bash
openssl rand -hex 32
```

## 5. Register the Telegram webhook (one-time)

```bash
cd /www/wwwroot/scrum.dzapp.io.vn
npx tsx scripts/set-webhook.ts https://scrum.dzapp.io.vn
npx tsx scripts/set-webhook.ts --info   # confirm
```

## 6. Trigger the first deploy

Push any commit to `main` (or **Actions → deploy → Run workflow**). The
workflow will:
- build with Node 20
- rsync code into `/www/wwwroot/scrum.dzapp.io.vn`
- `npm ci --omit=dev`
- `pm2 start/reload pm-scrum-bot` from `ecosystem.config.cjs`
- `pm2 save` so it survives reboot

Check:
```bash
pm2 status
pm2 logs pm-scrum-bot --lines 50
curl https://scrum.dzapp.io.vn/healthz   # should return 'ok'
```

## 7. Schedule the daily digest (replaces launchd)

In **aaPanel → Cron**:
- Type: Shell script
- Cycle: every Monday–Friday at 09:00
- Command:
  ```bash
  cd /www/wwwroot/scrum.dzapp.io.vn && /usr/bin/node dist/index.js >> logs/digest.log 2>&1
  ```

(If you have multiple Jira instances and want separate runs, add one cron per
project: `node dist/index.js --project WL`.)

## 8. Logs

| What                | Where                                                       |
|---------------------|-------------------------------------------------------------|
| Bot stdout/stderr   | `/www/wwwroot/scrum.dzapp.io.vn/logs/bot.{out,err}.log`     |
| Digest cron         | `/www/wwwroot/scrum.dzapp.io.vn/logs/digest.log`            |
| nginx               | aaPanel → Logs (per site)                                   |
| GH Actions          | https://github.com/zotabros/pm-scrum/actions                |

## 9. Rolling back

```bash
pm2 stop pm-scrum-bot
git -C /www/wwwroot/scrum.dzapp.io.vn ... # not a git repo — rollback by re-running an older Actions run via "Re-run jobs"
```

The deploy dir is **not** a git working copy — rsync overwrites it. If you need
fast rollback, re-run a previous successful workflow from GitHub UI.
