// In dev, use empty string so all calls are relative (go through Vite proxy → localhost:3001)
// In production, use the configured API URL
export const API_URL = import.meta.env.DEV
  ? ''
  : import.meta.env.VITE_API_URL;

export const CDN_URL = import.meta.env.DEV
  ? ''
  : import.meta.env.CDN_URL;

export const SOCKET_URL = import.meta.env.DEV
  ? ''
  : import.meta.env.VITE_GATEWAY_URL || import.meta.env.VITE_API_URL;
