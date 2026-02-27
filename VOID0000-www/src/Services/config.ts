// Force localhost in development mode
export const API_URL = import.meta.env.DEV 
  ? 'http://localhost:3001' 
  : import.meta.env.VITE_API_URL;

export const CDN_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : import.meta.env.CDN_URL;

export const SOCKET_URL = import.meta.env.DEV 
  ? 'http://localhost:3001' 
  : import.meta.env.VITE_API_URL;