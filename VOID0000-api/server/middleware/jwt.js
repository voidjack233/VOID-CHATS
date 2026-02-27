import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();
const ACCESS_SECRET = process.env.ACCESS_SECRET;

export const authenticateUser = (req, res, next) => {
  const token = req.cookies.accessToken;
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, ACCESS_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    // Don't clear cookies — let the refresh flow handle token renewal
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
};

// API ENDPOINT
router.get('/', (req, res) => {
  const token = req.cookies.accessToken;
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Missing token' });
  }

  try {
    const decoded = jwt.verify(token, ACCESS_SECRET);
    res.json({ success: true, user: decoded });
  } catch (err) {
    // 401, not 403 — so fetchWithAuth triggers the refresh flow
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
});

export default router;