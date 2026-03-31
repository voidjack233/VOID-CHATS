// server/routes/user/preferences.js
import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

const validThemes = ['void', 'ocean', 'forest', 'sunset', 'midnight'];
const validDensities = ['compact', 'comfortable'];
const validMessageGroupSpacing = [0, 4, 8, 16, 24];
const validChatFontScale = [12, 14, 15, 16, 18, 20, 24];

// GET /api/users/preferences
router.get('/preferences', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT theme, accent_color, bg_color, text_color, hover_color, density, message_group_spacing, chat_font_scale, message_notifications_enabled
       FROM user_preferences
       WHERE user_id = $1`,
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
  const {
    theme,
    accent_color,
    bg_color,
    text_color,
    hover_color,
    density,
    message_group_spacing,
    chat_font_scale,
    message_notifications_enabled,
  } = req.body;

  if (theme && !validThemes.includes(theme)) {
    return res.status(400).json({ error: 'Invalid theme' });
  }

  if (density && !validDensities.includes(density)) {
    return res.status(400).json({ error: 'Invalid density' });
  }

  if (
    message_group_spacing !== undefined &&
    !validMessageGroupSpacing.includes(Number(message_group_spacing))
  ) {
    return res.status(400).json({ error: 'Invalid message group spacing' });
  }

  if (
    chat_font_scale !== undefined &&
    !validChatFontScale.includes(Number(chat_font_scale))
  ) {
    return res.status(400).json({ error: 'Invalid chat font scale' });
  }

  if (message_notifications_enabled !== undefined && typeof message_notifications_enabled !== 'boolean') {
    return res.status(400).json({ error: 'Invalid message_notifications_enabled' });
  }

  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  for (const [name, value] of Object.entries({ accent_color, bg_color, text_color, hover_color })) {
    if (value && !hexPattern.test(value)) {
      return res.status(400).json({ error: `Invalid ${name.replace('_', ' ')}` });
    }
  }

  try {
    await pool.query(
      `INSERT INTO user_preferences (
         user_id, theme, accent_color, bg_color, text_color, hover_color, density,
         message_group_spacing, chat_font_scale, message_notifications_enabled, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         theme = COALESCE($2, user_preferences.theme),
         accent_color = COALESCE($3, user_preferences.accent_color),
         bg_color = COALESCE($4, user_preferences.bg_color),
         text_color = COALESCE($5, user_preferences.text_color),
         hover_color = COALESCE($6, user_preferences.hover_color),
         density = COALESCE($7, user_preferences.density),
         message_group_spacing = COALESCE($8, user_preferences.message_group_spacing),
         chat_font_scale = COALESCE($9, user_preferences.chat_font_scale),
         message_notifications_enabled = COALESCE($10, user_preferences.message_notifications_enabled),
         updated_at = NOW()`,
      [
        userId,
        theme || 'void',
        accent_color || '#6366f1',
        bg_color || '#111827',
        text_color || '#f3f4f6',
        hover_color || '#374151',
        density || 'compact',
        message_group_spacing ?? 8,
        chat_font_scale ?? 16,
        message_notifications_enabled !== undefined ? message_notifications_enabled : true,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Save preferences error:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

export default router;
