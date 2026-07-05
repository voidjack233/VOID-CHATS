import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import valkey from '../../../valkey.js';
import { ensureGroupOwner } from '../../../utils/groupMembership.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const OLDEST_MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const NEWER_MEMBER_ID = '33333333-3333-4333-8333-333333333333';

after(async () => {
  await valkey.quit();
});

test('ownerless group promotes the oldest active member deterministically', async () => {
  const updates = [];
  const database = {
    async query(sql, params) {
      if (sql.includes('SELECT id, type, owner_id')) {
        return { rows: [{ id: CONVERSATION_ID, type: 'group', owner_id: null }] };
      }
      if (sql.includes('SELECT user_id::text AS user_id, role')) {
        return {
          rows: [
            { user_id: OLDEST_MEMBER_ID, role: 'member', joined_key_version: 2 },
            { user_id: NEWER_MEMBER_ID, role: 'member', joined_key_version: 4 },
          ],
        };
      }
      if (sql.includes('SELECT id FROM conversations WHERE parent_conversation_id')) {
        return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
      }
      if (sql.includes('UPDATE conversations') || sql.includes('UPDATE conversation_members')) {
        updates.push({ sql, params });
      }
      return { rows: [] };
    },
  };

  const result = await ensureGroupOwner(database, CONVERSATION_ID);

  assert.deepEqual(result, { repaired: true, ownerUserId: OLDEST_MEMBER_ID });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].params[0], OLDEST_MEMBER_ID);
  assert.deepEqual(updates[0].params[1], [
    CONVERSATION_ID,
    '44444444-4444-4444-8444-444444444444',
  ]);
  assert.equal(updates[1].params[0], OLDEST_MEMBER_ID);
});

test('valid group owner requires no repair writes', async () => {
  let updateCount = 0;
  const database = {
    async query(sql) {
      if (sql.includes('SELECT id, type, owner_id')) {
        return {
          rows: [{ id: CONVERSATION_ID, type: 'group', owner_id: OLDEST_MEMBER_ID }],
        };
      }
      if (sql.includes('SELECT user_id::text AS user_id, role')) {
        return {
          rows: [{ user_id: OLDEST_MEMBER_ID, role: 'owner', joined_key_version: 2 }],
        };
      }
      if (sql.includes('UPDATE ')) updateCount += 1;
      return { rows: [] };
    },
  };

  const result = await ensureGroupOwner(database, CONVERSATION_ID);

  assert.deepEqual(result, { repaired: false, ownerUserId: OLDEST_MEMBER_ID });
  assert.equal(updateCount, 0);
});
