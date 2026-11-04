// PM2: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'approvals',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,            // SQLite: keep to one process
    autorestart: true,
    max_memory_restart: '300M',
    env: { NODE_ENV: 'production' },
  }],
};
