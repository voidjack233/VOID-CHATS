const browserCrypto = globalThis.crypto;

if (!browserCrypto) {
  throw new Error('Web Crypto API is unavailable in this browser runtime.');
}

export const webcrypto = browserCrypto;
export const subtle = browserCrypto.subtle;
export default browserCrypto;
