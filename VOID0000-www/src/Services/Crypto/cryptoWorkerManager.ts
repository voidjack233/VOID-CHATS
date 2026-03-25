// src/Services/Crypto/cryptoWorkerManager.ts

export class CryptoWorkerManager {
  private worker: Worker | null = null;
  private callbacks = new Map<number, { resolve: (val: string) => void; reject: (err: Error) => void }>();
  private jobIdCounter = 0;

  private init() {
    if (!this.worker) {
      // Vite specifically looks for this `import.meta.url` pattern to bundle the worker!
      this.worker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
        type: 'module',
      });

      this.worker.onmessage = (e: MessageEvent) => {
        const { id, success, plaintext, error } = e.data;
        const callback = this.callbacks.get(id);

        if (callback) {
          if (success) {
            callback.resolve(plaintext);
          } else {
            callback.reject(new Error(error));
          }
          this.callbacks.delete(id);
        }
      };
    }
  }

  public decryptAsync(encrypted_content: string, iv: string, key: CryptoKey): Promise<string> {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = ++this.jobIdCounter;
      this.callbacks.set(id, { resolve, reject });

      this.worker!.postMessage({
        id,
        encrypted_content,
        iv,
        key,
      });
    });
  }
}

export const cryptoWorker = new CryptoWorkerManager();
