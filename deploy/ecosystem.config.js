// PM2 process manager config - alternative to Docker for a plain VPS.
// Usage:
//   npm install -g pm2
//   npm install --omit=dev
//   npm run migrate
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup   # auto-restart on server reboot
module.exports = {
  apps: [
    {
      name: "leadgen-tool",
      script: "src/server.js",
      cwd: "..",
      instances: 1,          // keep at 1 unless you move rate limiting/SQLite off single-process
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
