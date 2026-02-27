import { customSecurityHeaders } from './headers.js';
import { customCSP } from './csp.js';

export { customSecurityHeaders, customCSP };

export const securityMiddleware = (allowedOrigins) => [
  customSecurityHeaders,
  customCSP(allowedOrigins)
];

export default securityMiddleware;