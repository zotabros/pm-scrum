# Scrum Digest

Daily Jira sprint digest → Telegram. Chạy hàng ngày các ngày trong tuần, tổng hợp tiến độ sprint của từng project Jira Cloud và gửi vào group Telegram tương ứng. Format theo kiểu daily meeting, **không có "hôm nay làm gì"** — chỉ liệt kê task đã hoàn thành kèm thời gian in-progress và các task TODO/Blocked để team thảo luận.

- Report thứ 2 bao quát **Fri 00:00 → Mon 00:00** (3 ngày cuối tuần).
- Report T3–T6 bao quát **ngày làm việc trước đó**.
- Thời gian in-progress của mỗi task đã done được tính từ changelog, làm tròn giờ (min 1h nếu >0, `—` nếu chưa từng vào In Progress).

## 1. Setup

```bash
cp .env.example .env
cp config.yaml.example config.yaml
npm install
npm run build
```

### 1.1. Jira API token

1. Vào https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token**, label `scrum-digest`, copy token
3. Điền vào `.env`:
   ```
   JIRA_BASE_URL=https://your-domain.atlassian.net
   JIRA_EMAIL=you@company.com
   JIRA_API_TOKEN=<token>
   ```
4. Kiểm tra nhanh:
   ```
   curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "$JIRA_BASE_URL/rest/api/3/myself"
   ```

### 1.2. Telegram bot

1. Nhắn [@BotFather](https://t.me/BotFather) → `/newbot` → nhận `TELEGRAM_BOT_TOKEN` → điền vào `.env`.
2. Thêm bot vào từng group project, **đặt làm admin** (để bot gửi được tin).
3. Khai báo project keys trong `config.yaml`:
   ```yaml
   projects:
     - key: PROJ-A
     - key: PROJ-B
       jira_instance: toptop   # optional, multi-instance
   ```
4. Subscribe group → project được quản lý qua bot command `/project` (xem mục 3).

### 1.3. (Optional) LLM sprint-health note

Set `ANTHROPIC_API_KEY` trong `.env` và bật `llm.enabled: true` trong `config.yaml`. Mỗi sprint/ngày gọi Claude Haiku 1 lần, cache tại `.cache/llm-notes.json`.

## 1.4. Bot server (webhook + /project subscription)

Cần long-running HTTP server nhận Telegram webhook để xử lý `/project`.

```bash
# 1. Init lần đầu — generate TELEGRAM_WEBHOOK_SECRET, build, migrate subscriptions
bash scripts/setup.sh

# 2. Mở public URL (Cloudflare Tunnel / ngrok / nginx) trỏ vào port 8081
# 3. Đăng ký webhook
PUBLIC_URL=https://bot.example.com bash scripts/setup.sh --register-webhook

# 4. Cài launchd agent (macOS) — server chạy thường trực, RunAtLoad + KeepAlive
bash scripts/setup.sh --install-launchd
```

Trong `.env` cần thêm:
```
TELEGRAM_WEBHOOK_SECRET=<32-byte hex>          # script tự generate nếu trống
TELEGRAM_WEBHOOK_PORT=8081
TELEGRAM_ADMIN_USER_IDS=123456789,...          # whitelist user, bypass admin check
```

Sau khi cài: trong group Telegram, người là admin group **hoặc** nằm trong whitelist gõ `/project` → hiện list buttons với trạng thái ✅/⚪ — bấm để toggle subscribe. Subscriptions lưu ở `data/subscriptions.json`.

## 2. Sử dụng

```bash
# Kiểm tra kết nối Jira + Telegram (gửi 1 ping tới project đầu tiên)
npm run check

# Dry-run: in message ra stdout, không gửi Telegram
npm run dev -- --dry-run

# Chỉ chạy 1 project
npm run dev -- --dry-run --project PROJ-A

# Chạy với ngày giả lập (test reproducibility)
npm run dev -- --dry-run --date 2026-04-10

# Chạy thật (build trước)
npm run build
npm start
```

## 3. Deploy với systemd (Ubuntu/Debian server)

```bash
sudo mkdir -p /opt/scrum-digest
sudo rsync -a --exclude node_modules --exclude .cache ./ /opt/scrum-digest/
cd /opt/scrum-digest
sudo npm ci --omit=dev
sudo npm run build
sudo chmod 600 .env

sudo cp systemd/scrum-digest.service /etc/systemd/system/
sudo cp systemd/scrum-digest.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scrum-digest.timer
```

Monitor:

```bash
systemctl list-timers scrum-digest.timer        # next scheduled run
journalctl -u scrum-digest.service -f           # live logs
journalctl -u scrum-digest.service --since today
systemctl start scrum-digest.service            # trigger manual run
```

## 4. Monitoring

Set `HEALTHCHECK_URL` trong `.env` (ví dụ từ https://healthchecks.io) — script sẽ ping sau mỗi lần chạy thành công, bạn nhận alert nếu bỏ sót ngày.

## 5. Cấu trúc

```
src/
├── index.ts           # cron orchestrator + CLI
├── server.ts          # bot webhook HTTP server entry
├── check.ts           # npm run check
├── config.ts          # env + YAML loaders (zod) + multi-instance Jira creds
├── logger.ts          # pino
├── window.ts          # since/until + weekday logic
├── jira/
│   ├── client.ts      # axios + auth + retry
│   ├── discover.ts    # projects → boards → active sprints
│   └── issues.ts      # JQL search + changelog
├── bot/
│   ├── webhook.ts     # node:http server, dispatch updates
│   ├── commands.ts    # /project, /start
│   ├── callbacks.ts   # subscribe toggle handler
│   └── auth.ts        # admin/whitelist check
├── storage/
│   └── subscriptions.ts  # JSON persistence, atomic write
├── aggregate.ts       # bucket + computeInProgressHours
├── format.ts          # MarkdownV2 renderer
├── telegram.ts        # Bot API client (send / edit / callback)
├── llm.ts             # optional Claude sprint-health note
└── types.ts
```

## 6. Hạn chế đã biết

- Không tự phát hiện ngày nghỉ lễ giữa tuần — report T5 sau T4 nghỉ vẫn chỉ lấy 1 ngày (T4).
- `hoursInProgress` là wall-clock, tính cả đêm/cuối tuần. V2 có thể thêm `business_hours_only: true`.
- `status changed TO` JQL chỉ bắt theo tên status — team có workflow lạ (custom "Done" state) cần chỉnh danh sách trong `aggregate.ts` (`fetchCompletedInWindow`).
