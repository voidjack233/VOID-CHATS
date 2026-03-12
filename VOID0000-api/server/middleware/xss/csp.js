export const customCSP = (allowedOrigins = []) => {
    return (req, res, next) => {
        const host = req.headers.host || 'localhost:3001';

        const directives = [
            "default-src 'self'",

            // Scripts - no unsafe-inline in production
            process.env.NODE_ENV === 'development'
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self'",

            "style-src 'self' 'unsafe-inline'",

            // Images - only from your CDN and local data/blob fallbacks
            "img-src 'self' data: blob: https://cdn.void0000.online",

            "font-src 'self' data:",

            // Connections - your origins + WebSocket
            `connect-src 'self' ${allowedOrigins.filter(o => o.startsWith('http')).join(' ')} ws://${host} wss://${host} wss://api.void0000.online https://*.void0000.online`,

            "frame-src 'self'",
            "object-src 'none'",
            "media-src 'self' data: blob:",
            "worker-src 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",

            // HTTPS upgrade in production
            ...(process.env.NODE_ENV === 'production' ? ["upgrade-insecure-requests"] : [])
        ];

        const cspHeader = directives.join('; ');

        // Report-only in development, enforced in production
        if (process.env.NODE_ENV === 'production') {
            res.setHeader('Content-Security-Policy', cspHeader);
        } else {
            res.setHeader('Content-Security-Policy-Report-Only', cspHeader);
        }

        next();
    };
};

export default customCSP;
