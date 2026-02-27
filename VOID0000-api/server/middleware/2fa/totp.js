import crypto from 'crypto';

class TOTP {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'sha1';
    this.digits = options.digits || 6;
    this.period = options.period || 30;
  }

  /**
   * Generate a random secret key (base32 encoded)
   */
  generateSecret(length = 20) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = crypto.randomBytes(length);
    let secret = '';

    for (let i = 0; i < bytes.length; i++) {
      secret += base32chars[bytes[i] % 32];
    }

    return secret;
  }

  /**
   * Generate a TOTP token
   */
  generateToken(secret, timestamp = Date.now()) {
    const time = Math.floor(timestamp / 1000 / this.period);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(time), 0);

    const secretBuffer = this._base32ToBuffer(secret);

    const hmac = crypto.createHmac(this.algorithm, secretBuffer);
    hmac.update(timeBuffer);
    const hmacResult = hmac.digest();

    const offset = hmacResult[hmacResult.length - 1] & 0xf;
    const code = ((hmacResult[offset] & 0x7f) << 24) |
                 ((hmacResult[offset + 1] & 0xff) << 16) |
                 ((hmacResult[offset + 2] & 0xff) << 8) |
                 (hmacResult[offset + 3] & 0xff);

    const otp = code % Math.pow(10, this.digits);
    return otp.toString().padStart(this.digits, '0');
  }

  /**
   * Verify a TOTP token (checks current + window for clock drift)
   */
  verifyToken(token, secret, window = 1) {
    if (!token || !secret) return false;

    const cleanToken = token.replace(/\s/g, '');
    if (cleanToken.length !== this.digits) return false;

    const currentTime = Date.now();

    for (let i = -window; i <= window; i++) {
      const timeOffset = currentTime + (i * this.period * 1000);
      const generatedToken = this.generateToken(secret, timeOffset);

      if (crypto.timingSafeEqual(
        Buffer.from(generatedToken),
        Buffer.from(cleanToken)
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate OTP Auth URL (for QR codes)
   */
  generateOTPAuthURL(secret, accountName, issuer = 'VOID0000') {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedAccount = encodeURIComponent(accountName);

    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=${this.algorithm.toUpperCase()}&digits=${this.digits}&period=${this.period}`;
  }

  /**
   * Get seconds remaining in current period
   */
  getRemainingSeconds() {
    return this.period - (Math.floor(Date.now() / 1000) % this.period);
  }

  /**
   * Convert base32 string to buffer
   */
  _base32ToBuffer(base32) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';

    const cleaned = base32.replace(/[\s=]/g, '').toUpperCase();

    for (let i = 0; i < cleaned.length; i++) {
      const val = base32chars.indexOf(cleaned.charAt(i));
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }

    const buffer = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      buffer.push(parseInt(bits.substr(i, 8), 2));
    }

    return Buffer.from(buffer);
  }
}

// Export singleton with default options
export const totp = new TOTP();
export default TOTP;