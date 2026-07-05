import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import { pool } from '../../../db.js';
import valkey from '../../../valkey.js';
import { createPendingSelfLeavesRouter } from '../pendingSelfLeaves.js';
import { hasPendingMembershipRotation } from '../messages/membershipRotationGuard.js';
import { registerMemberSelfLeaveRoutes } from './selfLeave.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const LEAVER_ID = '22222222-2222-4222-8222-222222222222';
const SURVIVOR_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';

after(async () => {
  await Promise.allSettled([pool.end(), valkey.quit()]);
});

test('member-role survivor recovers self-leave while leaver remains forbidden', async (t) => {
  const state = {
    claimOwner: null,
    currentKeyVersion: 4,
    rotationStatus: 'pending',
  };
  const rotationRow = () => ({
    operation_id: OPERATION_ID,
    target_user_ids: [LEAVER_ID],
    reserved_key_version: 5,
    status: state.rotationStatus,
  });
  const database = {
    async query(sql, params = []) {
      if (sql.includes('FROM conversation_membership_rotations rotations')) {
        return params[0] === SURVIVOR_ID && state.rotationStatus === 'pending'
          ? {
              rows: [{
                operation_id: OPERATION_ID,
                conversation_id: CONVERSATION_ID,
                conversation_public_id: '700216971412643840',
                target_user_id: LEAVER_ID,
                target_label: 'Leaving member',
                pending_key_version: 5,
                current_key_version: state.currentKeyVersion,
                survivor_role: 'member',
              }],
            }
          : { rows: [] };
      }
      if (sql.includes("AND kind = 'self_leave'")) {
        return { rows: [rotationRow()] };
      }
      if (sql.includes("status = 'pending'")) {
        return { rows: state.rotationStatus === 'pending' ? [{ operation_id: OPERATION_ID }] : [] };
      }
      if (sql.includes('SELECT 1') && sql.includes('conversation_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('SELECT 1') && sql.includes('conversation_members')) {
            return { rows: [] };
          }
          if (sql.includes('SELECT user_id::text AS user_id, role')) {
            return { rows: [{ user_id: SURVIVOR_ID, role: 'member' }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const cache = {
    async set(_key, value) {
      if (state.claimOwner == null) {
        state.claimOwner = value;
        return 'OK';
      }
      return null;
    },
    async get() {
      return state.claimOwner;
    },
    async ttl() {
      return 60;
    },
    async expire() {
      return 1;
    },
    async del() {
      state.claimOwner = null;
      return 1;
    },
  };
  const resolveConversation = async () => ({
    id: CONVERSATION_ID,
    public_id: '700216971412643840',
    type: 'group',
    owner_id: null,
    current_key_version: state.currentKeyVersion,
  });
  const getMembership = async (_db, _conversationId, userId) => (
    userId === SURVIVOR_ID ? { role: 'member' } : null
  );
  const lockRotation = async () => ({
    operation: {
      operationId: OPERATION_ID,
      actorUserId: LEAVER_ID,
      targetUserIds: [LEAVER_ID],
      reservedKeyVersion: 5,
      status: state.rotationStatus,
    },
    currentKeyVersion: state.currentKeyVersion,
  });

  const authenticate = (req, _res, next) => {
    req.user = { id: req.get('x-test-user') };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/conversations/membership-rotations',
    authenticate,
    createPendingSelfLeavesRouter({ database }),
  );
  const memberRouter = Router({ mergeParams: true });
  const systemMessages = [];
  registerMemberSelfLeaveRoutes(memberRouter, {
    cache,
    database,
    emitUpdate: async () => {},
    getMembership,
    insertFinalizeArtifacts: async () => {},
    lockRotation,
    markRotationFinalized: async () => {
      state.rotationStatus = 'finalized';
      state.currentKeyVersion = 5;
    },
    postSystemMessage: async (message) => {
      systemMessages.push({
        ...message,
        rotationStatusWhenPosted: state.rotationStatus,
      });
    },
    resolveConversation,
  });
  app.use('/api/conversations/:conversationId/members', authenticate, memberRouter);

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/conversations`;
  const headersFor = (userId) => ({
    'content-type': 'application/json',
    'x-test-user': userId,
  });

  const pendingResponse = await fetch(
    `${baseUrl}/membership-rotations/self-leaves/pending`,
    { headers: headersFor(SURVIVOR_ID) },
  );
  assert.equal(pendingResponse.status, 200);
  const pendingBody = await pendingResponse.json();
  assert.equal(pendingBody.rotations.length, 1);
  assert.equal(pendingBody.rotations[0].survivor_role, 'member');

  assert.equal(await hasPendingMembershipRotation(database, CONVERSATION_ID), true);

  const leaverClaim = await fetch(`${baseUrl}/${CONVERSATION_ID}/members/self-leave/claim`, {
    method: 'POST',
    headers: headersFor(LEAVER_ID),
    body: JSON.stringify({ operation_id: OPERATION_ID }),
  });
  assert.equal(leaverClaim.status, 403);

  const leaverFinalize = await fetch(`${baseUrl}/${CONVERSATION_ID}/members/self-leave/finalize`, {
    method: 'POST',
    headers: headersFor(LEAVER_ID),
    body: JSON.stringify({ operation_id: OPERATION_ID, mls_artifacts: {} }),
  });
  assert.equal(leaverFinalize.status, 403);

  const survivorClaim = await fetch(`${baseUrl}/${CONVERSATION_ID}/members/self-leave/claim`, {
    method: 'POST',
    headers: headersFor(SURVIVOR_ID),
    body: JSON.stringify({ operation_id: OPERATION_ID }),
  });
  assert.equal(survivorClaim.status, 200);
  assert.equal((await survivorClaim.json()).claimed, true);

  const survivorFinalize = await fetch(`${baseUrl}/${CONVERSATION_ID}/members/self-leave/finalize`, {
    method: 'POST',
    headers: headersFor(SURVIVOR_ID),
    body: JSON.stringify({
      operation_id: OPERATION_ID,
      mls_artifacts: {
        snapshot: {
          group_id: 'group-id',
          state_blob: 'state-blob',
          epoch: 5,
          key_version: 5,
        },
        welcomes: [],
        commit: null,
      },
    }),
  });
  assert.equal(survivorFinalize.status, 200);
  assert.equal((await survivorFinalize.json()).key_version, 5);
  assert.equal(state.rotationStatus, 'finalized');
  assert.equal(await hasPendingMembershipRotation(database, CONVERSATION_ID), false);
  assert.equal(systemMessages.length, 1);
  assert.deepEqual(systemMessages[0], {
    conversationId: CONVERSATION_ID,
    finalizerUserId: SURVIVOR_ID,
    keyVersion: 5,
    operationId: OPERATION_ID,
    targetUserId: LEAVER_ID,
    rotationStatusWhenPosted: 'finalized',
  });
});
