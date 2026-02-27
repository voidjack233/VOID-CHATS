import express from 'express';
import path from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Paths
const __dirname = path.resolve();
const distPath = path.join(__dirname, 'VOID0000-www/dist');

// Proxy /api to your backend
app.use('/api', createProxyMiddleware({
  target: 'http://localhost:3001',  // Your backend port
  changeOrigin: true,
  pathRewrite: { '^/api': '/api' }, // keep same path
}));

// Serve static React files
app.use(express.static(distPath));

// SPA fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
