import { Router } from 'express';
import { resolveCapabilities } from './shared.js';

const router = Router();

router.get('/capabilities', async (_req, res) => {
  try {
    return res.json({
      success: true,
      capabilities: resolveCapabilities(),
    });
  } catch (err) {
    console.error('MLS capabilities error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve MLS capabilities' });
  }
});

export default router;
