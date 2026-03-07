// server/routes/user/preferences.js
import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

// GET /api/users/preferences
router.get('/preferences', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT theme, accent_color, bg_color, text_color, hover_color FROM user_preferences WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, preferences: null });
    }

    res.json({ success: true, preferences: result.rows[0] });
  } catch (err) {
    console.error('Get preferences error:', err);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// PUT /api/users/preferences
router.put('/preferences', async (req, res) => {
  const userId = req.user.id;
  const { theme, accent_color, bg_color, text_color, hover_color } = req.body;

  const validThemes = ['void', 'ocean', 'forest', 'sunset', 'midnight'];
  if (theme && !validThemes.includes(theme)) {
    return res.status(400).json({ error: 'Invalid theme' });
  }

  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  for (const [name, value] of Object.entries({ accent_color, bg_color, text_color, hover_color })) {
    if (value && !hexPattern.test(value)) {
      return res.status(400).json({ error: `Invalid ${name.replace('_', ' ')}` });
    }
  }

  try {
    await pool.query(
      `INSERT INTO user_preferences (user_id, theme, accent_color, bg_color, text_color, hover_color, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         theme = COALESCE($2, user_preferences.theme),
         accent_color = COALESCE($3, user_preferences.accent_color),
         bg_color = COALESCE($4, user_preferences.bg_color),
         text_color = COALESCE($5, user_preferences.text_color),
         hover_color = COALESCE($6, user_preferences.hover_color),
         updated_at = NOW()`,
      [userId, theme || 'void', accent_color || '#6366f1', bg_color || '#111827', text_color || '#f3f4f6', hover_color || '#374151']
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Save preferences error:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

export default router;
