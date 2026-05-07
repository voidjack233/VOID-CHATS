import webPush from 'web-push';
import { pool } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';

const isConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (isConfigured) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[PUSH] Web Push disabled. Missing VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, or VAPID_SUBJECT.');
}

function hasUsableSubscription(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === 'string' &&
    subscription.endpoint.trim() &&
    subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    subscription.keys.p256dh.trim() &&
    typeof subscription.keys.auth === 'string' &&
    subscription.keys.auth.trim()
  );
}

function toPushSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

function getRouteForConversation(conversation) {
  const routeId = conversation?.public_id || conversation?.id;
  if (!routeId) return '/chats';

  if (conversation.type === 'dm') {
    return `/chats/@me/${routeId}`;
  }

  return `/chats/${routeId}`;
}

function buildMessageNotificationPayload({ conversation, senderName, mentioned }) {
  const conversationName = conversation?.name || 'Group';
  const title = mentioned
    ? `You were mentioned by ${senderName}`
    : conversation?.type === 'dm'
      ? `New message from ${senderName}`
      : `New message in ${conversationName}`;

  return {
    type: 'message',
    title,
    body: 'Open VOID to read it.',
    tag: `void-message:${conversation?.id || 'unknown'}`,
    url: getRouteForConversation(conversation),
    conversation_id: conversation?.id || null,
    conversation_public_id: conversation?.public_id || null,
    mentioned: Boolean(mentioned),
  };
}

async function markPushSuccess(subscriptionId) {
  await pool.query(
    `UPDATE push_subscriptions
     SET last_success_at = NOW(),
         last_failure_at = NULL,
         failure_count = 0,
         updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId]
  );
}

async function markPushFailure(subscriptionId, error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const shouldRevoke = statusCode === 404 || statusCode === 410;

  await pool.query(
    `UPDATE push_subscriptions
     SET last_failure_at = NOW(),
         failure_count = COALESCE(failure_count, 0) + 1,
         revoked_at = CASE WHEN $2::boolean THEN NOW() ELSE revoked_at END,
         enabled = CASE WHEN $2::boolean THEN FALSE ELSE enabled END,
         updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId, shouldRevoke]
  );
}

async function sendPayloadToRows(rows, payload) {
  if (!isConfigured || rows.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    rows.map((row) => webPush.sendNotification(toPushSubscription(row), body))
  );

  await Promise.all(results.map((result, index) => (
    result.status === 'fulfilled'
      ? markPushSuccess(rows[index].id)
      : markPushFailure(rows[index].id, result.reason)
  )));

  return {
    attempted: rows.length,
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

export function isWebPushConfigured() {
  return isConfigured;
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

export async function saveWebPushSubscription({ userId, deviceId, subscription, userAgent }) {
  if (!isConfigured) {
    const error = new Error('Browser push is not configured on this server');
    error.status = 503;
    throw error;
  }

  if (!hasUsableSubscription(subscription)) {
    const error = new Error('Invalid push subscription');
    error.status = 400;
    throw error;
  }

  const endpoint = subscription.endpoint.trim();
  const p256dh = subscription.keys.p256dh.trim();
  const auth = subscription.keys.auth.trim();

  const result = await pool.query(
    `INSERT INTO push_subscriptions (
       user_id, device_id, provider, endpoint, p256dh, auth, user_agent,
       enabled, revoked_at, updated_at
     )
     VALUES ($1, $2, 'web_push', $3, $4, $5, $6, TRUE, NULL, NOW())
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       device_id = EXCLUDED.device_id,
       provider = 'web_push',
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       enabled = TRUE,
       revoked_at = NULL,
       updated_at = NOW()
     RETURNING id`,
    [userId, deviceId, endpoint, p256dh, auth, userAgent || null]
  );

  return result.rows[0];
}

export async function revokeWebPushSubscription({ userId, deviceId, endpoint }) {
  if (endpoint) {
    await pool.query(
      `UPDATE push_subscriptions
       SET enabled = FALSE,
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE user_id = $1
         AND endpoint = $2`,
      [userId, endpoint]
    );
    return;
  }

  await pool.query(
    `UPDATE push_subscriptions
     SET enabled = FALSE,
         revoked_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $1
       AND device_id = $2
       AND provider = 'web_push'
       AND revoked_at IS NULL`,
    [userId, deviceId]
  );
}

export async function sendTestPush(userId) {
  if (!isConfigured) {
    return { configured: false, attempted: 0, delivered: 0, failed: 0 };
  }

  const result = await pool.query(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = $1
       AND provider = 'web_push'
       AND enabled = TRUE
       AND revoked_at IS NULL`,
    [userId]
  );

  const delivery = await sendPayloadToRows(result.rows, {
    type: 'test',
    title: 'VOID notifications are working',
    body: 'Browser push is enabled on this device.',
    tag: 'void-push-test',
    url: '/chats',
  });

  return { configured: true, ...delivery };
}

export async function dispatchMessagePushNotifications({
  senderId,
  recipientIds,
  conversation,
  mentions = [],
}) {
  if (!isConfigured || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return;
  }

  const targetUserIds = [...new Set(recipientIds.filter((id) => id && id !== senderId))];
  if (targetUserIds.length === 0) {
    return;
  }

  try {
    const senderResult = await pool.query(
      `SELECT COALESCE(NULLIF(up.display_name, ''), u.username) AS name
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [senderId]
    );
    const senderName = senderResult.rows[0]?.name || 'Someone';
    const mentionedIds = new Set(
      Array.isArray(mentions)
        ? mentions.map((mention) => mention?.user_id).filter(Boolean)
        : []
    );

    const subscriptionsResult = await pool.query(
      `SELECT ps.id, ps.user_id::text AS user_id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       LEFT JOIN user_preferences prefs ON prefs.user_id = ps.user_id
       WHERE ps.user_id = ANY($1::uuid[])
         AND ps.provider = 'web_push'
         AND ps.enabled = TRUE
         AND ps.revoked_at IS NULL
         AND COALESCE(prefs.message_notifications_enabled, TRUE) = TRUE`,
      [targetUserIds]
    );

    const rowsByUserId = new Map();
    for (const row of subscriptionsResult.rows) {
      const rows = rowsByUserId.get(row.user_id) || [];
      rows.push(row);
      rowsByUserId.set(row.user_id, rows);
    }

    await Promise.all(targetUserIds.map((recipientId) => {
      const rows = rowsByUserId.get(recipientId) || [];
      if (rows.length === 0) return Promise.resolve();

      return sendPayloadToRows(
        rows,
        buildMessageNotificationPayload({
          conversation,
          senderName,
          mentioned: mentionedIds.has(recipientId),
        })
      );
    }));
  } catch (error) {
    console.warn('[PUSH] failed to dispatch message push notifications', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
