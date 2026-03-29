// ecosystem.config.cjs
// PM2 process manager configuration
// Reads config.json to determine cluster mode

const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'server', 'config.json'), 'utf8')
);

const clusterEnabled = config.cluster.enabled;
const workers = config.cluster.workers || 4;
const gatewayMode = config.gateway?.mode || 'phoenix';

if (gatewayMode !== 'phoenix') {
  throw new Error(`Unsupported gateway.mode "${gatewayMode}". The Node gateway has been retired; use "phoenix".`);
}

const apps = [];

if (clusterEnabled) {
  // CLUSTER MODE: multiple API workers + external gateway transport
  apps.push({
    name: 'voidapp-api',
    script: 'server/server.js',
    instances: workers,
    exec_mode: 'cluster',
    env: {
      PORT: 3001,
      NODE_ENV: 'production',
    },
    max_memory_restart: '300M',
    watch: false,
    autorestart: true,
  });
} else {
  // SINGLE INSTANCE API with external Phoenix gateway.
  apps.push({
    name: 'voidapp-api',
    script: 'server/server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      PORT: 3001,
      NODE_ENV: 'production',
    },
    max_memory_restart: '500M',
    watch: false,
    autorestart: true,
  });
}

apps.push({
  name: 'voidapp-gateway-phoenix',
  script: 'startup/run-phoenix-gateway.sh',
  instances: 1,
  exec_mode: 'fork',
  interpreter: 'none',
  env: {
    NODE_ENV: 'production',
    MIX_ENV: 'prod',
    GATEWAY_PORT: 4001,
  },
  max_memory_restart: '300M',
  watch: false,
  autorestart: true,
});

module.exports = { apps };
