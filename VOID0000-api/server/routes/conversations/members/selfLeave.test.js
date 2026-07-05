import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../../db.js';
import valkey from '../../../valkey.js';
import {
  parseMembershipFinalizeArtifacts,
  resolveMembershipRepairWelcomeUserIds,
} from '../mls/finalizeArtifacts.js';
import {
  lockMembershipRotation,
  reserveMembershipRotation,
} from './membershipRotations.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const LEAVER_ID = '22222222-2222-4222-8222-222222222222';
const SURVIVOR_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';

after(async () => {
  await Promise.allSettled([
    pool.end(),
    valkey.quit(),
  ]);
});

test('self_leave reservation can remain pending without expiry', async () => {
  const observed = [];
  const client = {
    async query(sql, params = []) {
      observed.push({ sql, params });
      if (sql.includes('SELECT current_key_version')) {
        return {
          rows: [{
            current_key_version: 4,
            pending_add_key_version: null,
            pending_remove_key_version: null,
            pending_approve_key_version: null,
          }],
        };
      }
      if (sql.includes("WHERE conversation_id = $1\n       AND status = 'pending'\n     LIMIT 1")) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO conversation_membership_rotations')) {
        return {
          rows: [{
            operation_id: OPERATION_ID,
            kind: 'self_leave',
            actor_user_id: LEAVER_ID,
            target_user_ids: [LEAVER_ID],
            reserved_key_version: 5,
            join_request_id: null,
            status: 'pending',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const result = await reserveMembershipRotation(client, {
    conversationId: CONVERSATION_ID,
    actorUserId: LEAVER_ID,
    kind: 'self_leave',
    targetUserIds: [LEAVER_ID],
    requestedKeyVersion: 5,
    expiresInMs: null,
  });

  assert.equal(result.operation.kind, 'self_leave');
  const insert = observed.find(({ sql }) => sql.includes('INSERT INTO conversation_membership_rotations'));
  assert.equal(insert.params[6], null);
});

test('self_leave lock permits a different active finalizer only when explicitly enabled', async () => {
  const createClient = () => ({
    async query(sql) {
      if (sql.includes('SELECT current_key_version')) {
        return { rows: [{ current_key_version: 4 }] };
      }
      return {
        rows: [{
          operation_id: OPERATION_ID,
          kind: 'self_leave',
          actor_user_id: LEAVER_ID,
          target_user_ids: [LEAVER_ID],
          reserved_key_version: 5,
          join_request_id: null,
          status: 'pending',
        }],
      };
    },
  });

  await assert.rejects(
    lockMembershipRotation(createClient(), {
      conversationId: CONVERSATION_ID,
      operationId: OPERATION_ID,
      actorUserId: SURVIVOR_ID,
      kind: 'self_leave',
    }),
    (error) => error.code === 'MEMBERSHIP_OPERATION_MISMATCH',
  );

  const result = await lockMembershipRotation(createClient(), {
    conversationId: CONVERSATION_ID,
    operationId: OPERATION_ID,
    actorUserId: SURVIVOR_ID,
    kind: 'self_leave',
    allowDifferentActor: true,
  });
  assert.equal(result.operation.actorUserId, LEAVER_ID);
});

test('self_leave artifacts accept no welcomes in the normal removal path', () => {
  const baseArtifacts = {
    snapshot: {
      groupId: 'group-id',
      stateBlob: 'state-blob',
      epoch: 5,
      keyVersion: 5,
    },
    welcomes: [],
    commit: null,
  };

  const valid = parseMembershipFinalizeArtifacts(baseArtifacts, {
    expectedWelcomeUserIds: [],
    pendingKeyVersion: 5,
    requireCommit: false,
  });
  assert.ok(valid.artifacts);
  assert.deepEqual(valid.artifacts.welcomes, []);
});

test('self_leave artifacts allow repair welcomes only for active survivors', () => {
  const repairArtifacts = {
    snapshot: {
      groupId: 'group-id',
      stateBlob: 'state-blob',
      epoch: 5,
      keyVersion: 5,
    },
    welcomes: [{
      userId: SURVIVOR_ID,
      welcomeRef: OPERATION_ID,
      payload: 'welcome',
    }],
    commit: {
      commitRef: '55555555-5555-4555-8555-555555555555',
      payload: 'commit',
      epoch: 4,
    },
  };
  const welcomeResolution = resolveMembershipRepairWelcomeUserIds(
    repairArtifacts,
    [SURVIVOR_ID],
  );
  assert.deepEqual(welcomeResolution.welcomeUserIds, [SURVIVOR_ID]);

  const valid = parseMembershipFinalizeArtifacts(repairArtifacts, {
    expectedWelcomeUserIds: welcomeResolution.welcomeUserIds,
    pendingKeyVersion: 5,
    requireCommit: true,
  });
  assert.ok(valid.artifacts);

  const invalidResolution = resolveMembershipRepairWelcomeUserIds({
    snapshot: repairArtifacts.snapshot,
    welcomes: [{
      userId: LEAVER_ID,
      welcomeRef: OPERATION_ID,
      payload: 'welcome',
    }],
    commit: repairArtifacts.commit,
  }, [SURVIVOR_ID]);
  assert.equal(invalidResolution.code, 'MLS_ARTIFACTS_INVALID');
  assert.match(invalidResolution.error, /active remaining members/i);
});

test('multi-survivor self_leave artifacts require a commit', () => {
  const result = parseMembershipFinalizeArtifacts({
    snapshot: {
      groupId: 'group-id',
      stateBlob: 'state-blob',
      epoch: 5,
      keyVersion: 5,
    },
    welcomes: [],
    commit: null,
  }, {
    expectedWelcomeUserIds: [],
    pendingKeyVersion: 5,
    requireCommit: true,
  });

  assert.equal(result.code, 'MLS_ARTIFACTS_INVALID');
  assert.match(result.error, /commit is required/i);
});
