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
const GROUP_AVATAR_BUCKET = process.env.MINIO_GROUP_AVATAR_BUCKET || 'group-avatars';
const ATTACH_BUCKET = process.env.MINIO_ATTACH_BUCKET || 'chat-attachments';

async function ensureBucketExists(bucket) {
  const exists = await minioClient.bucketExists(bucket);
  if (!exists) {
    await minioClient.makeBucket(bucket);
    console.log(`✅ MinIO bucket '${bucket}' created`);
  }
}

function buildPublicReadPolicy(bucket) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucket}/*`],
    }],
  });
}

async function ensurePublicReadBucket(bucket) {
  await ensureBucketExists(bucket);
  await minioClient.setBucketPolicy(bucket, buildPublicReadPolicy(bucket));
  console.log(`✅ MinIO bucket '${bucket}' public read policy set`);
}

async function ensurePrivateBucket(bucket) {
  await ensureBucketExists(bucket);
  try {
    await minioClient.setBucketPolicy(bucket, '');
  } catch (err) {
    const code = err?.code || err?.name || '';
    const message = err?.message || '';
    if (!String(code).includes('NoSuchBucketPolicy') && !message.includes('policy does not exist')) {
      throw err;
    }
  }
  console.log(`✅ MinIO bucket '${bucket}' private policy set`);
}

// Ensure buckets exist on startup
(async () => {
  try {
    await Promise.all([
      ensurePublicReadBucket(BUCKET),
      ensurePublicReadBucket(GROUP_AVATAR_BUCKET),
      ensurePrivateBucket(ATTACH_BUCKET),
    ]);
    console.log('✅ MinIO connected');
  } catch (err) {
    console.error('❌ MinIO init error:', err.message);
  }
})();

export { minioClient, BUCKET, GROUP_AVATAR_BUCKET, ATTACH_BUCKET };
