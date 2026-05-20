import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../../db.js';
import { callSignalLimiter } from '../../middleware/rate_limit.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier, isUuid } from '../../utils/conversationIdentity.js';

const router = Router();

const CALL_SIGNAL_EVENTS = new Set([
  'CALL_INVITE',
  'CALL_ACCEPT',
  'CALL_REJECT',
  'CALL_CANCEL',
  'CALL_END',
  'WEBRTC_OFFER',
  'WEBRTC_ANSWER',
  'ICE_CANDIDATE',
]);

const MAX_SIGNAL_BODY_BYTES = 64 * 1024;
const MAX_CALL_ID_LENGTH = 128;
const MAX_SDP_LENGTH = 60 * 1024;
const MAX_SDP_BASE64_LENGTH = 96 * 1024;
const MAX_CANDIDATE_LENGTH = 8 * 1024;
const MAX_REASON_LENGTH = 512;

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function sanitizeSignalPayload(body) {
  const payload = {};

  const callId = boundedString(body.call_id, MAX_CALL_ID_LENGTH);
  if (callId) payload.call_id = callId;

  const media = boundedString(body.media, 32);
  if (media) payload.media = media;

  const reason = boundedString(body.reason, MAX_REASON_LENGTH);
  if (reason) payload.reason = reason;

  const sdp = boundedString(body.sdp, MAX_SDP_LENGTH);
  if (sdp) payload.sdp = sdp;

  const sdpBase64 = boundedString(body.sdp_base64, MAX_SDP_BASE64_LENGTH);
  if (sdpBase64) payload.sdp_base64 = sdpBase64;

  const candidate = boundedString(body.candidate, MAX_CANDIDATE_LENGTH);
  if (candidate) payload.candidate = candidate;

  if (body.candidate_init && typeof body.candidate_init === 'object') {
    payload.candidate_init = {
      candidate: boundedString(body.candidate_init.candidate, MAX_CANDIDATE_LENGTH),
      sdpMid: boundedString(body.candidate_init.sdpMid, 128) || null,
      sdpMLineIndex: Number.isInteger(body.candidate_init.sdpMLineIndex)
        ? body.candidate_init.sdpMLineIndex
        : null,
      usernameFragment: boundedString(body.candidate_init.usernameFragment, 256) || null,
    };
  }

  return payload;
}

async function verifyCallParticipants(conversationId, senderId, targetUserId) {
  const result = await pool.query(
    `SELECT user_id::text AS user_id
     FROM conversation_members
     WHERE conversation_id = $1
       AND user_id = ANY($2::uuid[])`,
    [conversationId, [senderId, targetUserId]]
  );

  const memberIds = new Set(result.rows.map((row) => row.user_id));
  return memberIds.has(senderId) && memberIds.has(targetUserId);
}

router.get('/', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-call-service',
    signaling: 'enabled',
  });
});

router.post('/signal', callSignalLimiter, async (req, res) => {
  const senderId = req.user?.id;
  const senderDeviceId = req.user?.device_id || null;
  const body = req.body || {};

  try {
    if (jsonByteLength(body) > MAX_SIGNAL_BODY_BYTES) {
      return res.status(413).json({
        success: false,
        message: 'Call signal payload is too large',
        code: 'CALL_SIGNAL_TOO_LARGE',
      });
    }

    const event = boundedString(body.event, 64);
    if (!CALL_SIGNAL_EVENTS.has(event)) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported call signal event',
        code: 'CALL_SIGNAL_EVENT_INVALID',
      });
    }

    const targetUserId = boundedString(body.target_user_id, 64);
    if (!isUuid(targetUserId)) {
      return res.status(400).json({
        success: false,
        message: 'Target user is invalid',
        code: 'CALL_TARGET_INVALID',
      });
    }

    if (targetUserId === senderId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot signal yourself',
        code: 'CALL_TARGET_SELF',
      });
    }

    const conversationIdentifier = boundedString(body.conversation_id, 128);
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found',
        code: 'CALL_CONVERSATION_NOT_FOUND',
      });
    }

    const allowed = await verifyCallParticipants(conversation.id, senderId, targetUserId);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: 'Both call participants must be conversation members',
        code: 'CALL_MEMBERSHIP_REQUIRED',
      });
    }

    const payload = {
      ...sanitizeSignalPayload(body),
      event_id: randomUUID(),
      event,
      conversation_id: conversation.id,
      conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
      conversation_type: conversation.type,
      from_user_id: senderId,
      from_device_id: senderDeviceId,
      target_user_id: targetUserId,
      server_timestamp: Date.now(),
    };

    sendLiveEventToUser(targetUserId, event, payload);

    res.json({
      success: true,
      event_id: payload.event_id,
    });
  } catch (err) {
    console.error('Call signal error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send call signal',
      code: 'CALL_SIGNAL_FAILED',
    });
  }
});

export default router;
