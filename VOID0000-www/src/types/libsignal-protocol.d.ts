declare module 'libsignal-protocol/dist/libsignal-protocol.js';
declare module 'libsignal-protocol/dist/libsignal-protocol.js?raw' {
  const source: string;
  export default source;
}

interface Window {
  libsignal?: any;
}
