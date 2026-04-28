import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { initPublisher } = await import('../valkey-pubsub.js');
const { initPresenceFanout } = await import('../gateway/presence-fanout.js');
const { startImageWorker } = await import('../queues/imageQueue.js');
const { cleanupAllExpired } = await import('../utils/cleanUpExpired.js');

initPublisher();
initPresenceFanout();

const imageWorker = startImageWorker();

async function runCleanup() {
  try {
    await cleanupAllExpired();
    console.log('✅ Expired data cleanup done');
  } catch (error) {
    console.error('❌ Expired data cleanup failed:', error);
  }
}

await runCleanup();
const cleanupInterval = setInterval(runCleanup, 6 * 60 * 60 * 1000);

async function shutdown(signal) {
  console.log(`Worker service received ${signal}, shutting down...`);
  clearInterval(cleanupInterval);
  await imageWorker.close().catch((error) => {
    console.error('Image worker shutdown failed:', error);
  });
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

console.log(`✅ Worker service running (PID ${process.pid})`);
