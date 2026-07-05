import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPendingSelfLeavesRouter } from '../pendingSelfLeaves.js';

const USER_ID = '33333333-3333-4333-8333-333333333333';

test('authenticated pending self-leave recovery returns an empty rotation list', async (t) => {
  const observedQueries = [];
  const database = {
    async query(sql, params) {
      observedQueries.push({ sql, params });
      return { rows: [] };
    },
  };
  const authenticateUser = (req, _res, next) => {
    req.user = { id: USER_ID };
    next();
  };
  const app = express();

  app.use(
    '/api/conversations/membership-rotations',
    authenticateUser,
    createPendingSelfLeavesRouter({ database }),
  );
  app.use('/api/conversations/:conversationId', (_req, res) => {
    res.status(418).json({ success: false, error: 'dynamic route matched' });
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  await new Promise((resolve) => server.once('listening', resolve));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/conversations/membership-rotations/self-leaves/pending`,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/i);
  assert.deepEqual(await response.json(), { success: true, rotations: [] });
  assert.equal(observedQueries.length, 1);
  assert.deepEqual(observedQueries[0].params, [USER_ID]);
});
