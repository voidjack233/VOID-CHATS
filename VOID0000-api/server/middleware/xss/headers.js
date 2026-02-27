export const customSecurityHeaders = (req, res, next) => {
  // ==================== ESSENTIAL HEADERS ====================
  
  // HSTS - Forces HTTPS
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
    // Add '; preload' only when 100% committed
  );
  
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Privacy control
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Disable legacy XSS filter (can cause issues in modern browsers)
  res.setHeader('X-XSS-Protection', '0');
  
  // ==================== MODERN SECURITY ====================
  
  // Permissions-Policy
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), autoplay=(self), fullscreen=(self)'
  );
  
  // ==================== ADDITIONAL PROTECTIONS ====================
  
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  
  // ==================== CACHE CONTROL ====================
  
  const sensitivePaths = ['/api/me', '/api/users', '/api/auth', '/api/friends'];
  if (sensitivePaths.some(path => req.path.startsWith(path))) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  
  next();
};

export default customSecurityHeaders;