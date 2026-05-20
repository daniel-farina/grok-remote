// PM2 ecosystem for grok-remote.
// Run `pm2 start ecosystem.config.cjs` (the installer does this for you).

module.exports = {
  apps: [
    {
      name: 'grok-remote',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 7910,
        HOST: process.env.GROK_REMOTE_HOST || '0.0.0.0',
      },
      out_file: './logs/grok-remote.out.log',
      error_file: './logs/grok-remote.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
