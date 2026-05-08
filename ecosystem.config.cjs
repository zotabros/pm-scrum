// PM2 ecosystem for the Telegram bot webhook server.
// The cron-driven digest (`node dist/index.js`) runs from aaPanel cron, NOT here.
module.exports = {
  apps: [
    {
      name: "pm-scrum-bot",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 5000,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Ho_Chi_Minh",
      },
      out_file: "./logs/bot.out.log",
      error_file: "./logs/bot.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
