import Redis from 'ioredis';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
  lazyConnect: false,
});

valkey.on('connect', () => console.log('✅ Valkey connected'));
valkey.on('error', (err) => console.error('❌ Valkey error:', err.message));

export default valkey;