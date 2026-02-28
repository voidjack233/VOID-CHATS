// server/minio.js
import * as Minio from 'minio';

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

const BUCKET = process.env.MINIO_BUCKET || 'avatars';

// Ensure bucket exists on startup
(async () => {
  try {
    const exists = await minioClient.bucketExists(BUCKET);
    if (!exists) {
      await minioClient.makeBucket(BUCKET);
      console.log(`✅ MinIO bucket '${BUCKET}' created`);
    }
    console.log('✅ MinIO connected');
  } catch (err) {
    console.error('❌ MinIO init error:', err.message);
  }
})();

export { minioClient, BUCKET };