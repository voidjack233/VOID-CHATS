import { Router } from 'express';
import {
  getVapidPublicKey,
  isWebPushConfigured,
  revokeWebPushSubscription,
  saveWebPushSubscription,
  sendTestPush,
} from '../../notifications/webPush.js';

const router = Router();

router.get('/vapid-public-key', (_req, res) => {
  res.json({
    success: true,
    configured: isWebPushConfigured(),
    publicKey: getVapidPublicKey(),
  });
});

router.post('/subscribe', async (req, res) => {
  const userId = req.user.id;
  const deviceId = req.user.device_id;
  const userAgent = req.get('user-agent') || null;

  try {
    const subscription = req.body?.subscription;
    const saved = await saveWebPushSubscription({
      userId,
      deviceId,
      subscription,
      userAgent,
    });

    res.json({
      success: true,
      subscriptionId: saved.id,
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error('[PUSH] subscribe failed:', error);
    res.status(status).json({
      success: false,
      error: error?.message || 'Failed to save push subscription',
    });
  }
});

router.post('/unsubscribe', async (req, res) => {
  const userId = req.user.id;
  const deviceId = req.user.device_id;
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;

  try {
    await revokeWebPushSubscription({ userId, deviceId, endpoint });
    res.json({ success: true });
  } catch (error) {
    console.error('[PUSH] unsubscribe failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disable push subscription',
    });
  }
});

router.post('/test', async (req, res) => {
  try {
    const result = await sendTestPush(req.user.id);
    res.json({
      success: result.configured,
      ...result,
      error: result.configured ? undefined : 'Browser push is not configured on this server',
    });
  } catch (error) {
    console.error('[PUSH] test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test push',
    });
  }
});

export default router;
