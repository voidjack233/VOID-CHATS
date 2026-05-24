import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { pool } from '../../db.js';
import { EVENTS } from '../../gateway/protocol.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { callActionLimiter } from '../../middleware/rate_limit.js';

const router = Router();
const LIVE_STATUSES = ['ringing', 'active'];
const TERMINAL_STATUSES = new Set(['ended', 'rejected', 'cancelled', 'missed']);

class CallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getSfuProvider() {
  return (process.env.CALL_SFU_PROVIDER || 'unconfigured').trim() || 'unconfigured';
}

function isLiveKitConfigured() {
  return Boolean(
    process.env.CALL_SFU_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

function buildSfuJoinPayload({ session, userId }) {
  const provider = getSfuProvider();
  const roomName = session.sfu_room_name;
  const participantIdentity = String(userId);
  const participantName = participantIdentity;

  if (provider === 'livekit' && isLiveKitConfigured()) {
    const now = Math.floor(Date.now() / 1000);
    const grants = {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    };

    const token = jwt.sign(
      {
        video: grants,
        nbf: now - 10,
      },
      process.env.LIVEKIT_API_SECRET,
      {
        algorithm: 'HS256',
        issuer: process.env.LIVEKIT_API_KEY,
        subject: participantIdentity,
        expiresIn: '10m',
      }
    );

    return {
      configured: true,
      provider,
      url: process.env.CALL_SFU_URL,
      room_name: roomName,
      participant_identity: participantIdentity,
      participant_name: participantName,
      token,
    };
  }

  return {
    configured: false,
    provider,
    url: process.env.CALL_SFU_URL || null,
    room_name: roomName,
    participant_identity: participantIdentity,
    participant_name: participantName,
    token: null,
    message: 'SFU media server is not configured yet.',
  };
}

function normalizeSession(row, userId) {
  if (!row) return null;
  const isCaller = row.started_by === userId;

  return {
    call_id: row.id,
    conversation_id: row.conversation_id,
    conversation_public_id: row.conversation_public_id ? String(row.conversation_public_id) : null,
    conversation_type: row.conversation_type || 'dm',
    from_user_id: row.started_by,
    target_user_id: row.target_user_id,
    peer_user_id: isCaller ? row.target_user_id : row.started_by,
    media: row.media,
    status: row.status,
    direction: isCaller ? 'outgoing' : 'incoming',
    sfu_provider: row.sfu_provider,
    sfu_room_name: row.sfu_room_name,
    started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    answered_at: row.answered_at ? new Date(row.answered_at).toISOString() : null,
    ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    ended_by: row.ended_by || null,
    end_reason: row.end_reason || null,
  };
}

function normalizeEventPayload(row) {
  return {
    call_id: row.id,
    conversation_id: row.conversation_id,
    conversation_public_id: row.conversation_public_id ? String(row.conversation_public_id) : null,
    conversation_type: row.conversation_type || 'dm',
    from_user_id: row.started_by,
    target_user_id: row.target_user_id,
    media: row.media,
    status: row.status,
    sfu_provider: row.sfu_provider,
    sfu_room_name: row.sfu_room_name,
    started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    answered_at: row.answered_at ? new Date(row.answered_at).toISOString() : null,
    ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    ended_by: row.ended_by || null,
    end_reason: row.end_reason || null,
  };
}

function emitCallEvent(event, session) {
  const payload = {
    event,
    ...normalizeEventPayload(session),
  };

  if (event === EVENTS.CALL_INVITE) {
    sendLiveEventToUser(session.target_user_id, event, payload);
    sendLiveEventToUser(session.started_by, EVENTS.CALL_STATE, payload);
    return;
  }

  sendLiveEventToUser(session.started_by, event, payload);
  sendLiveEventToUser(session.target_user_id, event, payload);
}

async function lockUserPair(client, firstUserId, secondUserId) {
  const locks = [firstUserId, secondUserId].filter(Boolean).sort();
  for (const lockId of locks) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sfu-call:${lockId}`]);
  }
}

async function resolveDmConversation(client, conversationIdentifier, userId) {
  if (!conversationIdentifier) {
    throw new CallError(400, 'CONVERSATION_REQUIRED', 'Conversation is required');
  }

  const result = await client.query(
    `SELECT c.id,
            c.public_id,
            c.type,
            other_member.user_id AS target_user_id
       FROM conversations c
       JOIN conversation_members my_member
         ON my_member.conversation_id = c.id
        AND my_member.user_id = $2
       JOIN conversation_members other_member
         ON other_member.conversation_id = c.id
        AND other_member.user_id <> $2
      WHERE (c.id::text = $1 OR c.public_id::text = $1)
        AND c.type = 'dm'
      LIMIT 1`,
    [conversationIdentifier, userId]
  );

  const conversation = result.rows[0];
  if (!conversation) {
    throw new CallError(404, 'CALL_CONVERSATION_NOT_FOUND', 'Direct message conversation not found');
  }

  if (!conversation.target_user_id) {
    throw new CallError(400, 'CALL_TARGET_NOT_FOUND', 'Could not find the other member for this call');
  }

  return conversation;
}

async function getLiveSessionForUser(client, userId) {
  const result = await client.query(
    `SELECT cs.*, c.public_id AS conversation_public_id, c.type AS conversation_type
       FROM sfu_call_sessions cs
       JOIN conversations c ON c.id = cs.conversation_id
      WHERE (cs.started_by = $1 OR cs.target_user_id = $1)
        AND cs.status = ANY($2::text[])
      ORDER BY cs.started_at DESC
      LIMIT 1`,
    [userId, LIVE_STATUSES]
  );

  return result.rows[0] || null;
}

async function getSessionForUser(client, callId, userId, options = {}) {
  const result = await client.query(
    `SELECT cs.*, c.public_id AS conversation_public_id, c.type AS conversation_type
       FROM sfu_call_sessions cs
       JOIN conversations c ON c.id = cs.conversation_id
      WHERE cs.id = $1
        AND (cs.started_by = $2 OR cs.target_user_id = $2)
      ${options.forUpdate ? 'FOR UPDATE OF cs' : ''}
      LIMIT 1`,
    [callId, userId]
  );

  const session = result.rows[0];
  if (!session) {
    throw new CallError(404, 'CALL_NOT_FOUND', 'Call not found');
  }

  return session;
}

function sendCallResponse(res, session, userId, includeJoin = false) {
  const body = {
    success: true,
    call: normalizeSession(session, userId),
  };

  if (includeJoin) {
    body.sfu = buildSfuJoinPayload({ session, userId });
  }

  res.json(body);
}

function handleCallRouteError(res, error, fallbackMessage) {
  if (error instanceof CallError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  console.error(fallbackMessage, error);
  return res.status(500).json({
    success: false,
    code: 'CALL_SERVER_ERROR',
    message: fallbackMessage,
  });
}

router.get('/active', async (req, res) => {
  try {
    const session = await getLiveSessionForUser(pool, req.user.id);
    res.json({
      success: true,
      call: normalizeSession(session, req.user.id),
    });
  } catch (error) {
    handleCallRouteError(res, error, 'Failed to inspect active call');
  }
});

router.post('/start', callActionLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    const media = req.body?.media === 'video' ? 'video' : 'audio';
    const conversation = await resolveDmConversation(client, req.body?.conversation_id, req.user.id);

    await client.query('BEGIN');
    await lockUserPair(client, req.user.id, conversation.target_user_id);

    const existing = await client.query(
      `SELECT id
         FROM sfu_call_sessions
        WHERE status = ANY($1::text[])
          AND (
            started_by = $2 OR target_user_id = $2 OR
            started_by = $3 OR target_user_id = $3
          )
        LIMIT 1`,
      [LIVE_STATUSES, req.user.id, conversation.target_user_id]
    );

    if (existing.rows.length > 0) {
      throw new CallError(409, 'CALL_ALREADY_ACTIVE', 'One of you already has a call in progress');
    }

    const callId = randomUUID();
    const roomName = `void-${callId}`;
    const insert = await client.query(
      `INSERT INTO sfu_call_sessions (
         id, conversation_id, started_by, target_user_id, media, sfu_provider, sfu_room_name
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *,
         $8::bigint AS conversation_public_id,
         $9::text AS conversation_type`,
      [
        callId,
        conversation.id,
        req.user.id,
        conversation.target_user_id,
        media,
        getSfuProvider(),
        roomName,
        conversation.public_id,
        conversation.type,
      ]
    );

    await client.query('COMMIT');
    const session = insert.rows[0];
    emitCallEvent(EVENTS.CALL_INVITE, session);
    sendCallResponse(res, session, req.user.id, true);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleCallRouteError(res, error, 'Failed to start call');
  } finally {
    client.release();
  }
});

router.post('/:callId/accept', callActionLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const session = await getSessionForUser(client, req.params.callId, req.user.id, { forUpdate: true });

    if (session.target_user_id !== req.user.id) {
      throw new CallError(403, 'CALL_ACCEPT_FORBIDDEN', 'Only the called user can answer this call');
    }
    if (session.status !== 'ringing') {
      throw new CallError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing');
    }

    const updated = await client.query(
      `UPDATE sfu_call_sessions
          SET status = 'active',
              answered_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
          $2::bigint AS conversation_public_id,
          $3::text AS conversation_type`,
      [session.id, session.conversation_public_id, session.conversation_type]
    );

    await client.query('COMMIT');
    const nextSession = updated.rows[0];
    emitCallEvent(EVENTS.CALL_ACCEPT, nextSession);
    sendCallResponse(res, nextSession, req.user.id, true);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleCallRouteError(res, error, 'Failed to accept call');
  } finally {
    client.release();
  }
});

async function finishCall({ req, res, terminalStatus, event, actorRule, reasonFallback }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const session = await getSessionForUser(client, req.params.callId, req.user.id, { forUpdate: true });

    if (TERMINAL_STATUSES.has(session.status)) {
      await client.query('COMMIT');
      return sendCallResponse(res, session, req.user.id);
    }

    if (actorRule === 'target' && session.target_user_id !== req.user.id) {
      throw new CallError(403, 'CALL_ACTION_FORBIDDEN', 'Only the called user can do this');
    }
    if (actorRule === 'caller' && session.started_by !== req.user.id) {
      throw new CallError(403, 'CALL_ACTION_FORBIDDEN', 'Only the caller can do this');
    }

    const updated = await client.query(
      `UPDATE sfu_call_sessions
          SET status = $2,
              ended_at = NOW(),
              ended_by = $3,
              end_reason = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
          $5::bigint AS conversation_public_id,
          $6::text AS conversation_type`,
      [
        session.id,
        terminalStatus,
        req.user.id,
        req.body?.reason || reasonFallback,
        session.conversation_public_id,
        session.conversation_type,
      ]
    );

    await client.query('COMMIT');
    const nextSession = updated.rows[0];
    emitCallEvent(event, nextSession);
    sendCallResponse(res, nextSession, req.user.id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleCallRouteError(res, error, 'Failed to update call');
  } finally {
    client.release();
  }
}

router.post('/:callId/reject', callActionLimiter, (req, res) => finishCall({
  req,
  res,
  terminalStatus: 'rejected',
  event: EVENTS.CALL_REJECT,
  actorRule: 'target',
  reasonFallback: 'declined',
}));

router.post('/:callId/cancel', callActionLimiter, (req, res) => finishCall({
  req,
  res,
  terminalStatus: 'cancelled',
  event: EVENTS.CALL_CANCEL,
  actorRule: 'caller',
  reasonFallback: 'cancelled',
}));

router.post('/:callId/end', callActionLimiter, (req, res) => finishCall({
  req,
  res,
  terminalStatus: 'ended',
  event: EVENTS.CALL_END,
  actorRule: 'participant',
  reasonFallback: 'ended',
}));

router.post('/:callId/join', callActionLimiter, async (req, res) => {
  try {
    const session = await getSessionForUser(pool, req.params.callId, req.user.id);
    if (!LIVE_STATUSES.includes(session.status)) {
      throw new CallError(409, 'CALL_NOT_LIVE', 'This call is no longer live');
    }
    sendCallResponse(res, session, req.user.id, true);
  } catch (error) {
    handleCallRouteError(res, error, 'Failed to create SFU join token');
  }
});

export default router;
