import { Router } from 'express';
import { pool } from '../../../db.js';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import {
  ensureSchema,
  getAvailableKeyPackageCount,
  isEnabledFor,
  MLS_KEY_PACKAGE_LOW_WATERMARK,
  MLS_KEY_PACKAGE_MINIMUM,
  MLS_KEY_PACKAGE_TARGET,
  MAX_PACKAGE_DATA_LENGTH,
  MAX_PACKAGE_REF_LENGTH,
  normalizeRequiredString,
  normalizeUserId,
  notEnabled,
  resolveCapabilities,
} from './shared.js';

const router = Router();

router.post('/key-packages', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'key_packages')) {
    return notEnabled(res, 'key_packages');
  }

  const requesterUserId = String(req.user.id);
  const userId = requesterUserId;
  const packageRef = normalizeRequiredString(req.body?.package_ref, MAX_PACKAGE_REF_LENGTH);
  const packageData = normalizeRequiredString(req.body?.package_data, MAX_PACKAGE_DATA_LENGTH);

  if (!packageRef) {
    return res.status(400).json({ success: false, error: 'package_ref is required and must be <= 255 characters' });
  }

  if (!packageData) {
    return res.status(400).json({ success: false, error: 'package_data is required and must be <= 1MB' });
  }

  try {
    await ensureSchema();

    console.log('[MLS_KEY_PACKAGE] publish request ref', {
      user_id: userId,
      package_ref: packageRef,
    });

    const result = await pool.query(
      `INSERT INTO mls_key_packages (user_id, package_ref, package_data, published_at)
       VALUES ($1::UUID, $2, $3, NOW())
       ON CONFLICT (user_id, package_ref)
       DO UPDATE SET
         package_data = EXCLUDED.package_data,
         published_at = NOW()
       RETURNING user_id::text AS user_id,
                 package_ref,
                 published_at,
                 (xmax = 0) AS inserted`,
      [userId, packageRef, packageData]
    );
    const row = result.rows[0];
    let availableCount = null;
    try {
      availableCount = await getAvailableKeyPackageCount(userId);
    } catch (countErr) {
      console.warn('[MLS_KEY_PACKAGE] publish post-write count failed', {
        user_id: userId,
        package_ref: packageRef,
        error: countErr,
      });
    }

    console.log('[MLS_KEY_PACKAGE] publish upsert result', {
      user_id: userId,
      package_ref: packageRef,
      action: row?.inserted ? 'inserted' : 'updated_on_conflict',
      conflicted: row?.inserted !== true,
      available_count: availableCount,
    });

    return res.json({
      success: true,
      data: {
        user_id: row?.user_id,
        package_ref: row?.package_ref,
        published_at: row?.published_at,
      },
    });
  } catch (err) {
    console.error('MLS key package publish error:', {
      user_id: userId,
      package_ref: packageRef,
      error: err,
    });
    return res.status(500).json({ success: false, error: 'Failed to publish MLS key package' });
  }
});

router.get('/key-packages/:userId/check', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'key_packages')) {
    return notEnabled(res, 'key_packages');
  }

  const targetUserId = normalizeUserId(req.params.userId);
  if (!targetUserId) {
    return res.status(400).json({ success: false, error: 'userId param is required' });
  }

  try {
    await ensureSchema();
    const count = await getAvailableKeyPackageCount(targetUserId);

    console.log('[MLS_KEY_PACKAGE] count endpoint raw count', {
      user_id: targetUserId,
      available_count: count,
    });

    return res.json({
      success: true,
      data: {
        available: count > 0,
        availableCount: count,
        count,
        minimumRequired: MLS_KEY_PACKAGE_MINIMUM,
        targetRecommended: MLS_KEY_PACKAGE_TARGET,
      },
    });
  } catch (err) {
    console.error('MLS key package check error:', err);
    return res.status(500).json({ success: false, error: 'Failed to check MLS key package availability' });
  }
});

router.get('/key-packages/:userId', async (req, res) => {
  const capabilities = resolveCapabilities();
  if (!isEnabledFor(capabilities, 'key_packages')) {
    return notEnabled(res, 'key_packages');
  }

  const requesterUserId = String(req.user.id);
  const targetUserId = normalizeUserId(req.params.userId);
  if (!targetUserId) {
    return res.status(400).json({ success: false, error: 'userId param is required' });
  }

  let client;
  try {
    await ensureSchema();
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE mls_key_packages
       SET consumed_at = NOW()
       WHERE id = (
         SELECT id FROM mls_key_packages
         WHERE user_id = $1::UUID
           AND published_at IS NOT NULL
           AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING user_id::text AS user_id, package_ref, package_data, published_at`,
      [targetUserId]
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No key packages available for this user', code: 'NO_KEY_PACKAGE' });
    }

    console.log('[MLS_KEY_PACKAGE] claim endpoint selected ref', {
      requester_user_id: requesterUserId,
      owner_user_id: targetUserId,
      package_ref: result.rows[0].package_ref,
    });

    void requesterUserId;

    try {
      const remainingCount = await getAvailableKeyPackageCount(targetUserId);
      console.log('[MLS_KEY_PACKAGE] claim remaining available count', {
        owner_user_id: targetUserId,
        available_count: remainingCount,
      });
      if (remainingCount < MLS_KEY_PACKAGE_LOW_WATERMARK) {
        sendLiveEventToUser(targetUserId, 'KEY_PACKAGE_LOW', {
          available_count: remainingCount,
          low_watermark: MLS_KEY_PACKAGE_LOW_WATERMARK,
          target_recommended: MLS_KEY_PACKAGE_TARGET,
        });
      }
    } catch (notifyErr) {
      console.warn('MLS key package low watermark notification failed:', notifyErr);
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('MLS key package claim error:', err);
    return res.status(500).json({ success: false, error: 'Failed to claim MLS key package' });
  } finally {
    client?.release();
  }
});

export default router;
