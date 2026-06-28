import { Router } from 'express';
import { createCanvas } from 'canvas';
import crypto from 'crypto';
import { saveCaptchaChallenge } from '../../utils/captchaStore.js';

const router = Router();

// Helper: random int
function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

// Helper: random color
function randomColor(min = 50, max = 150) {
  return `rgb(${randomInt(min, max)}, ${randomInt(min, max)}, ${randomInt(min, max)})`;
}

router.get('/', async (req, res) => {
  try {
    const width = 300;
    const height = 80;
    const charCount = 6;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    // Generate random text
    let text = '';
    for (let i = 0; i < charCount; i++) {
      text += chars[randomInt(0, chars.length - 1)];
    }

    // Create canvas
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#1f2937'; // dark bg to match your theme
    ctx.fillRect(0, 0, width, height);

    // Draw characters with random rotation and position
    const spacing = width / (charCount + 1);

    for (let i = 0; i < charCount; i++) {
      ctx.save();

      const x = spacing * (i + 1);
      const y = height / 2 + randomInt(-8, 8);

      ctx.translate(x, y);
      ctx.rotate((randomInt(-30, 30) * Math.PI) / 180);

      ctx.font = `bold ${randomInt(28, 36)}px monospace`;
      ctx.fillStyle = randomColor(150, 255);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text[i], 0, 0);

      ctx.restore();
    }

    // Noise lines
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(randomInt(0, width), randomInt(0, height));
      ctx.lineTo(randomInt(0, width), randomInt(0, height));
      ctx.strokeStyle = randomColor(80, 160);
      ctx.lineWidth = randomInt(1, 2);
      ctx.stroke();
    }

    // Noise dots
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = randomColor(100, 200);
      ctx.beginPath();
      ctx.arc(randomInt(0, width), randomInt(0, height), randomInt(1, 2), 0, 2 * Math.PI);
      ctx.fill();
    }

    // Generate captcha ID and store solution
    const captchaId = crypto.randomBytes(16).toString('hex');
    await saveCaptchaChallenge(captchaId, text.toUpperCase());

    // Convert canvas to base64 PNG
    const imageData = canvas.toDataURL('image/png');

    res.json({
      success: true,
      captchaId,
      image: imageData
    });

  } catch (err) {
    console.error('Captcha generation error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate captcha' });
  }
});

export default router;
