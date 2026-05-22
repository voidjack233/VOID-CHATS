import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../../db.js';
import { callSignalLimiter } from '../../middleware/rate_limit.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier, isUuid } from '../../utils/conversationIdentity.js';
import { sendConversationMessage } from '../conversations/messages/sendMessage.js';

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
const RINGING_CALL_TIMEOUT_MS = 60_000;
const ACTIVE_CALL_HEARTBEAT_TIMEOUT_MS = 45_000;
const TERMINAL_CALL_STATUSES = new Set(['ended', 'declined', 'canceled', 'missed', 'failed']);
const LIVE_CALL_STATUSES = ['ringing', 'active'];
const WEBRTC_SIGNAL_EVENTS = new Set(['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'ICE_CANDIDATE']);

class CallSignalError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

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

async function getUserDisplayName(userId) {
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(profile.display_name, ''), NULLIF(users.username, ''), 'Someone') AS name
     FROM users
     LEFT JOIN user_profiles profile ON profile.id = users.profile_id
     WHERE users.id = $1
     LIMIT 1`,
    [userId]
  );

  return result.rows[0]?.name || 'Someone';
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

async function postCallSystemMessage({ actorId, conversationId, content }) {
  try {
    await sendConversationMessage({
      userId: actorId,
      conversationIdentifier: conversationId,
      body: {
        message_type: 'system',
        content,
      },
    });
  } catch (error) {
    console.warn('[CALL_SESSION] failed to post call system message', {
      conversation_id: conversationId,
      error: error instanceof Error ? error.message : String(error || ''),
    });
  }
}

async function getCallSession(callId) {
  const result = await pool.query(
    `SELECT *,
            EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds
     FROM call_sessions
     WHERE call_id = $1
     LIMIT 1`,
    [callId]
  );

  return result.rows[0] || null;
}

function serializeCallSessionForUser(session, userId, deviceId = null) {
  if (!session) return null;
  const startedBy = String(session.started_by);
  const targetUserId = String(session.target_user_id);
  const peerUserId = startedBy === userId ? targetUserId : startedBy;

  return {
    call_id: session.call_id,
    conversation_id: String(session.conversation_id),
    conversation_public_id: session.conversation_public_id ? String(session.conversation_public_id) : null,
    conversation_type: session.conversation_type,
    from_user_id: startedBy,
    target_user_id: targetUserId,
    peer_user_id: peerUserId,
    media: session.media,
    status: session.status,
    direction: startedBy === userId ? 'outgoing' : 'incoming',
    started_at: session.started_at,
    answered_at: session.answered_at,
    answered_by_device_id: session.answered_by_device_id || null,
    answered_here: Boolean(deviceId && session.answered_by_device_id && session.answered_by_device_id === deviceId),
    duration_seconds: session.duration_seconds || 0,
  };
}

async function emitMissedCallForSession(session, reason = 'missed') {
  const actorName = await getUserDisplayName(session.started_by);
  await postCallSystemMessage({
    actorId: session.started_by,
    conversationId: session.conversation_id,
    content: `Missed audio call from ${actorName}`,
  });

  const payload = {
    event_id: randomUUID(),
    event: 'CALL_CANCEL',
    call_id: session.call_id,
    conversation_id: session.conversation_id,
    conversation_public_id: session.conversation_public_id ? String(session.conversation_public_id) : null,
    conversation_type: session.conversation_type,
    from_user_id: session.started_by,
    target_user_id: session.target_user_id,
    media: session.media,
    reason,
    call_status: session.status,
    call_duration_seconds: session.duration_seconds || 0,
    server_timestamp: Date.now(),
  };

  sendLiveEventToUser(session.started_by, 'CALL_CANCEL', payload);
  sendLiveEventToUser(session.target_user_id, 'CALL_CANCEL', payload);
}

async function emitCallEndedForSession(session, reason = 'ended') {
  const durationSeconds = session.duration_seconds || 0;
  const content = reason === 'disconnected'
    ? `Call ended · ${formatDuration(durationSeconds)}`
    : `Call ended · ${formatDuration(durationSeconds)}`;

  await postCallSystemMessage({
    actorId: session.ended_by || session.started_by,
    conversationId: session.conversation_id,
    content,
  });

  const payload = {
    event_id: randomUUID(),
    event: 'CALL_END',
    call_id: session.call_id,
    conversation_id: session.conversation_id,
    conversation_public_id: session.conversation_public_id ? String(session.conversation_public_id) : null,
    conversation_type: session.conversation_type,
    from_user_id: session.ended_by || session.started_by,
    target_user_id: session.ended_by === session.started_by ? session.target_user_id : session.started_by,
    media: session.media,
    reason,
    call_status: session.status,
    call_duration_seconds: durationSeconds,
    server_timestamp: Date.now(),
  };

  sendLiveEventToUser(session.started_by, 'CALL_END', payload);
  sendLiveEventToUser(session.target_user_id, 'CALL_END', payload);
}

export async function expireStaleRingingCalls({ olderThanMs = RINGING_CALL_TIMEOUT_MS } = {}) {
  const result = await pool.query(
    `UPDATE call_sessions
     SET status = 'missed',
         ended_at = NOW(),
         end_reason = 'timeout',
         updated_at = NOW()
     WHERE status = 'ringing'
       AND started_at < NOW() - ($1::int * INTERVAL '1 millisecond')
     RETURNING *,
       EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::int AS duration_seconds`,
    [olderThanMs]
  );

  for (const session of result.rows) {
    await emitMissedCallForSession(session, 'timeout');
  }

  return result.rows.length;
}

export async function expireStaleActiveCalls({ olderThanMs = ACTIVE_CALL_HEARTBEAT_TIMEOUT_MS } = {}) {
  const result = await pool.query(
    `UPDATE call_sessions
     SET status = 'failed',
         ended_at = NOW(),
         end_reason = 'disconnected',
         updated_at = NOW()
     WHERE status = 'active'
       AND (
         COALESCE(started_by_last_seen_at, answered_at, started_at) < NOW() - ($1::int * INTERVAL '1 millisecond')
         OR COALESCE(target_last_seen_at, answered_at, started_at) < NOW() - ($1::int * INTERVAL '1 millisecond')
       )
     RETURNING *,
       EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds`,
    [olderThanMs]
  );

  for (const session of result.rows) {
    await emitCallEndedForSession(session, 'disconnected');
  }

  return result.rows.length;
}

export async function expireStaleCallSessions() {
  const [ringing, active] = await Promise.all([
    expireStaleRingingCalls(),
    expireStaleActiveCalls(),
  ]);
  return { ringing, active };
}

async function touchCallParticipant(callId, userId) {
  if (!callId || !userId) return null;
  const result = await pool.query(
    `UPDATE call_sessions
     SET started_by_last_seen_at = CASE WHEN started_by = $2 THEN NOW() ELSE started_by_last_seen_at END,
         target_last_seen_at = CASE WHEN target_user_id = $2 THEN NOW() ELSE target_last_seen_at END,
         last_signal_at = NOW(),
         updated_at = NOW()
     WHERE call_id = $1
       AND status = ANY($3::text[])
       AND (started_by = $2 OR target_user_id = $2)
     RETURNING *,
       EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds`,
    [callId, userId, LIVE_CALL_STATUSES]
  );

  return result.rows[0] || null;
}

async function createRingingCallSession({ callId, conversation, senderId, targetUserId, media }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock both account rows in a stable order. This serializes simultaneous
    // invites across multiple devices/processes for the same participants.
    const participantIds = [senderId, targetUserId].sort();
    await client.query(
      `SELECT id
       FROM users
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [participantIds]
    );

    const existingResult = await client.query(
      `SELECT *,
              EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds
       FROM call_sessions
       WHERE call_id = $1
       LIMIT 1`,
      [callId]
    );
    if (existingResult.rows[0]) {
      await client.query('COMMIT');
      return { ...existingResult.rows[0], was_created: false };
    }

    const replacedOutgoingResult = await client.query(
      `UPDATE call_sessions
       SET status = 'missed',
           ended_at = NOW(),
           ended_by = $2,
           end_reason = 'replaced',
           updated_at = NOW()
       WHERE call_id <> $1
         AND status = 'ringing'
         AND started_by = $2
         AND target_user_id = $3
         AND conversation_id = $4
       RETURNING *,
         EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::int AS duration_seconds`,
      [callId, senderId, targetUserId, conversation.id]
    );

    const busyResult = await client.query(
      `SELECT call_id,
              status,
              started_by::text AS started_by,
              target_user_id::text AS target_user_id
       FROM call_sessions
       WHERE status = ANY($1::text[])
         AND (
           started_by = ANY($2::uuid[])
           OR target_user_id = ANY($2::uuid[])
         )
       ORDER BY started_at DESC
       LIMIT 1
       FOR UPDATE`,
      [LIVE_CALL_STATUSES, participantIds]
    );
    const busyCall = busyResult.rows[0] || null;
    if (busyCall) {
      const senderAlreadyBusy =
        busyCall.started_by === senderId || busyCall.target_user_id === senderId;
      throw new CallSignalError(
        409,
        senderAlreadyBusy ? 'CALL_ALREADY_IN_PROGRESS' : 'CALL_BUSY',
        senderAlreadyBusy
          ? 'You already have a call in progress'
          : 'This user is already in a call',
        {
          busy_call_id: busyCall.call_id,
          busy_status: busyCall.status,
        }
      );
    }

    const inserted = await client.query(
      `INSERT INTO call_sessions (
        call_id, conversation_id, conversation_public_id, conversation_type,
        started_by, target_user_id, media, status, started_by_last_seen_at, last_signal_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ringing', NOW(), NOW())
      RETURNING *,
        EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds`,
      [
        callId,
        conversation.id,
        conversation.public_id || null,
        conversation.type,
        senderId,
        targetUserId,
        media || 'audio',
      ]
    );

    await client.query('COMMIT');
    return {
      ...inserted.rows[0],
      was_created: true,
      replaced_outgoing_sessions: replacedOutgoingResult.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertCallSessionMatchesSignal({ session, event, conversation, senderId, targetUserId }) {
  if (!session) {
    throw new CallSignalError(404, 'CALL_NOT_FOUND', 'Call session not found');
  }
  if (TERMINAL_CALL_STATUSES.has(session.status)) {
    throw new CallSignalError(409, 'CALL_NOT_LIVE', 'This call is no longer active', {
      call_status: session.status,
    });
  }
  if (String(session.conversation_id) !== String(conversation.id)) {
    throw new CallSignalError(409, 'CALL_CONVERSATION_MISMATCH', 'Call does not belong to this conversation');
  }
  if (
    !(
      session.started_by === senderId && session.target_user_id === targetUserId
    ) &&
    !(
      session.started_by === targetUserId && session.target_user_id === senderId
    )
  ) {
    throw new CallSignalError(403, 'CALL_PARTICIPANT_MISMATCH', 'Call participants do not match this signal');
  }

  if (event === 'CALL_ACCEPT' && senderId !== session.target_user_id) {
    throw new CallSignalError(403, 'CALL_ACCEPT_FORBIDDEN', 'Only the called user can answer this call');
  }
  if (event === 'CALL_REJECT' && senderId !== session.target_user_id) {
    throw new CallSignalError(403, 'CALL_REJECT_FORBIDDEN', 'Only the called user can decline this call');
  }
  if (event === 'CALL_CANCEL' && senderId !== session.started_by) {
    throw new CallSignalError(403, 'CALL_CANCEL_FORBIDDEN', 'Only the caller can cancel this call');
  }
  if (event === 'WEBRTC_OFFER' && senderId !== session.started_by) {
    throw new CallSignalError(403, 'CALL_OFFER_FORBIDDEN', 'Only the caller can create the call offer');
  }
  if (event === 'WEBRTC_ANSWER' && senderId !== session.target_user_id) {
    throw new CallSignalError(403, 'CALL_ANSWER_FORBIDDEN', 'Only the receiver can answer the call offer');
  }
}

async function recordCallLifecycle({ event, callId, conversation, senderId, targetUserId, senderDeviceId, media, reason: rawReason }) {
  if (!callId) {
    return null;
  }

  if (event === 'CALL_INVITE') {
    const session = await createRingingCallSession({
      callId,
      conversation,
      senderId,
      targetUserId,
      media,
    });

    if (session.was_created) {
      for (const replacedSession of session.replaced_outgoing_sessions || []) {
        await emitMissedCallForSession(replacedSession, 'replaced');
      }

      const actorName = await getUserDisplayName(senderId);
      await postCallSystemMessage({
        actorId: senderId,
        conversationId: conversation.id,
        content: `${actorName} started an audio call`,
      });
    }

    return session;
  }

  const existing = await getCallSession(callId);
  assertCallSessionMatchesSignal({
    session: existing,
    event,
    conversation,
    senderId,
    targetUserId,
  });

  if (WEBRTC_SIGNAL_EVENTS.has(event)) {
    if (existing.status !== 'active') {
      throw new CallSignalError(409, 'CALL_NOT_ACTIVE', 'This call is not ready for audio signaling', {
        call_status: existing.status,
      });
    }
    return touchCallParticipant(callId, senderId);
  }

  if (!existing || TERMINAL_CALL_STATUSES.has(existing.status)) {
    return existing;
  }

  if (event === 'CALL_ACCEPT') {
    if (existing.status === 'active') {
      throw new CallSignalError(
        409,
        'CALL_ALREADY_ANSWERED',
        'This call was already answered'
      );
    }
    if (existing.status !== 'ringing') {
      throw new CallSignalError(
        409,
        'CALL_NOT_RINGING',
        'This call is no longer ringing'
      );
    }

    const accepted = await pool.query(
      `UPDATE call_sessions
       SET status = 'active',
           answered_at = COALESCE(answered_at, NOW()),
           answered_by_device_id = COALESCE(answered_by_device_id, $2),
           started_by_last_seen_at = NOW(),
           target_last_seen_at = NOW(),
           last_signal_at = NOW(),
           updated_at = NOW()
       WHERE call_id = $1
         AND status = 'ringing'
       RETURNING *,
         EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds`,
      [callId, senderDeviceId]
    );
    if (accepted.rows[0]) {
      return accepted.rows[0];
    }

    const latest = await getCallSession(callId);
    throw new CallSignalError(
      409,
      latest?.status === 'active' ? 'CALL_ALREADY_ANSWERED' : 'CALL_NOT_RINGING',
      latest?.status === 'active' ? 'This call was already answered' : 'This call is no longer ringing',
      {
        answered_by_device_id: latest?.answered_by_device_id || null,
      }
    );
  }

  const actorName = await getUserDisplayName(senderId);
  let nextStatus = 'ended';
  let reason = 'ended';
  let message = `${actorName} ended the call`;

  if (event === 'CALL_REJECT') {
    nextStatus = 'declined';
    reason = 'declined';
    message = `${actorName} declined the call`;
  } else if (event === 'CALL_CANCEL') {
    if (rawReason === 'missed' || rawReason === 'timeout') {
      nextStatus = 'missed';
      reason = 'missed';
      message = `Missed audio call from ${actorName}`;
    } else {
      nextStatus = 'canceled';
      reason = 'canceled';
      message = `${actorName} canceled the call`;
    }
  } else if (event !== 'CALL_END') {
    return existing;
  }

  const updated = await pool.query(
    `UPDATE call_sessions
     SET status = $2,
         ended_at = COALESCE(ended_at, NOW()),
         ended_by = $3,
         end_reason = $4,
         last_signal_at = NOW(),
         updated_at = NOW()
     WHERE call_id = $1
       AND status NOT IN ('ended', 'declined', 'canceled', 'missed', 'failed')
     RETURNING *,
       EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds`,
    [callId, nextStatus, senderId, reason]
  );

  const session = updated.rows[0] || existing;
  if (nextStatus === 'ended') {
    message = `${actorName} ended the call · ${formatDuration(session.duration_seconds)}`;
  }

  await postCallSystemMessage({
    actorId: senderId,
    conversationId: conversation.id,
    content: message,
  });

  return session;
}

router.get('/', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-call-service',
    signaling: 'enabled',
  });
});

router.get('/active', async (req, res) => {
  const userId = req.user?.id;
  const deviceId = req.user?.device_id || null;

  try {
    await expireStaleCallSessions();

    const result = await pool.query(
      `SELECT *,
              EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - COALESCE(answered_at, started_at)))::int AS duration_seconds
       FROM call_sessions
       WHERE status = ANY($1::text[])
         AND (started_by = $2 OR target_user_id = $2)
       ORDER BY started_at DESC
       LIMIT 1`,
      [LIVE_CALL_STATUSES, userId]
    );

    res.json({
      success: true,
      call: serializeCallSessionForUser(result.rows[0] || null, userId, deviceId),
    });
  } catch (err) {
    console.error('Active call lookup error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to inspect active call',
      code: 'CALL_ACTIVE_LOOKUP_FAILED',
    });
  }
});

router.post('/heartbeat', callSignalLimiter, async (req, res) => {
  const userId = req.user?.id;
  const deviceId = req.user?.device_id || null;
  const callId = boundedString(req.body?.call_id, MAX_CALL_ID_LENGTH);

  if (!callId) {
    return res.status(400).json({
      success: false,
      message: 'Call id is required',
      code: 'CALL_ID_REQUIRED',
    });
  }

  try {
    const session = await touchCallParticipant(callId, userId);
    if (!session) {
      const existing = await getCallSession(callId);
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing ? 'This call is no longer active' : 'Call session not found',
        code: existing ? 'CALL_NOT_LIVE' : 'CALL_NOT_FOUND',
        call_status: existing?.status || null,
      });
    }

    res.json({
      success: true,
      call: serializeCallSessionForUser(session, userId, deviceId),
    });
  } catch (err) {
    console.error('Call heartbeat error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update call heartbeat',
      code: 'CALL_HEARTBEAT_FAILED',
    });
  }
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

    await expireStaleCallSessions();

    const session = await recordCallLifecycle({
      event,
      callId: payload.call_id,
      conversation,
      senderId,
      targetUserId,
      senderDeviceId,
      media: payload.media,
      reason: payload.reason,
    });
    if (session) {
      payload.call_status = session.status;
      payload.call_duration_seconds = session.duration_seconds || 0;
      payload.answered_by_device_id = session.answered_by_device_id || null;
    }

    sendLiveEventToUser(targetUserId, event, payload);
    if (event === 'CALL_ACCEPT' || event === 'CALL_REJECT') {
      sendLiveEventToUser(senderId, 'CALL_CLEARED_ELSEWHERE', {
        ...payload,
        event: 'CALL_CLEARED_ELSEWHERE',
        clear_reason: event === 'CALL_ACCEPT' ? 'answered' : 'declined',
      });
    }

    res.json({
      success: true,
      event_id: payload.event_id,
    });
  } catch (err) {
    if (err instanceof CallSignalError) {
      return res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
        ...err.extra,
      });
    }

    console.error('Call signal error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send call signal',
      code: 'CALL_SIGNAL_FAILED',
    });
  }
});

export default router;
