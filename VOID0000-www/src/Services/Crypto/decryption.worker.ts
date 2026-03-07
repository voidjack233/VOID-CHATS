// src/Services/Crypto/decryption.worker.ts

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

self.onmessage = async function (e: MessageEvent) {
  const { id, encrypted_content, iv, key } = e.data;

  try {
    const ivBuffer = base64ToArrayBuffer(iv);
    const encryptedBuffer = base64ToArrayBuffer(encrypted_content);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuffer },
      key,
      encryptedBuffer
    );

    const decoder = new TextDecoder();
    const plaintext = decoder.decode(decrypted);

    self.postMessage({ id, success: true, plaintext });
  } catch (err: any) {
    self.postMessage({ id, success: false, error: 'Decryption failed: ' + (err.message || err.toString()) });
  }
};