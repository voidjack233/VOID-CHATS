// server/queues/imageQueue.js
import { Queue, Worker, QueueEvents } from 'bullmq';
import sharp from 'sharp';
import { pool } from '../db.js';
import { minioClient, BUCKET } from '../minio.js';
import { profileCache } from '../middleware/profileCache.js';
import { debugLog } from '../utils/debugLog.js';

const connection = {
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
};

// ============== QUEUE ==============

export const imageQueue = new Queue('image-processing', { connection });
export const imageQueueEvents = new QueueEvents('image-processing', { connection });

/**
 * Add an image processing job to the queue
 * Called from the avatar upload route
 */
export async function queueImageUpload({ userId, profileId, imageData, oldFilename }) {
  const job = await imageQueue.add(
    'process-avatar',
    {
      userId,
      profileId,
      imageData, // already base64 string
      oldFilename,
      queuedAt: Date.now(),
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    }
  );

  return { jobId: job.id, job, status: 'queued' };
}

// ============== WORKER ==============

export function startImageWorker() {
  const worker = new Worker(
    'image-processing',
    async (job) => {
      const { userId, profileId, imageData, oldFilename } = job.data;
      debugLog(`🖼️ Processing avatar for user ${userId.substring(0, 8)}...`);

      // 1. Decode base64 to buffer
      const buffer = Buffer.from(imageData, 'base64');

      // 2. Process with sharp (resize, strip EXIF, convert to webp)
      const processed = await sharp(buffer)
        .resize(256, 256, { fit: 'cover', position: 'center' })
        .rotate() // auto-rotate based on EXIF then strip it
        .webp({ quality: 80 })
        .toBuffer();

      // 3. Upload to MinIO
      const avatarFilename = `avatar-${profileId}-${Date.now()}.webp`;

      await minioClient.putObject(
        BUCKET,
        avatarFilename,
        processed,
        processed.length,
        { 'Content-Type': 'image/webp' }
      );

      // 4. Update database
      await pool.query(
        `UPDATE user_profiles
         SET avatar_filename = $1, updated_at = NOW()
         WHERE id = $2`,
        [avatarFilename, profileId]
      );

      // 5. Invalidate profile cache
      await profileCache.invalidate(profileId);

      // 6. Delete old avatar from MinIO
      if (oldFilename) {
        try {
          await minioClient.removeObject(BUCKET, oldFilename);
          debugLog(`🗑️ Deleted old avatar: ${oldFilename}`);
        } catch (err) {
          console.warn(`⚠️ Could not delete old avatar: ${err.message}`);
        }
      }

      debugLog(`✅ Avatar processed: ${avatarFilename}`);
      return { success: true, filename: avatarFilename };
    },
    {
      connection,
      concurrency: 3,
      limiter: {
        max: 10,
        duration: 60000,
      },
    }
  );

  worker.on('completed', (job, result) => {
    debugLog(`✅ Image job ${job.id} completed: ${result.filename}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Image job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('Image worker error:', err);
  });

  debugLog('🖼️ Image processing worker started');
  return worker;
}

// ============== QUEUE STATUS ==============

export async function getQueueStatus() {
  const [waiting, active, completed, failed] = await Promise.all([
    imageQueue.getWaitingCount(),
    imageQueue.getActiveCount(),
    imageQueue.getCompletedCount(),
    imageQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}
