import crypto from 'crypto';
import { deviceCookieOptions } from './cookieConfig.js';

function buildStableFingerprintSeed(req) {
  return [
    req.get('User-Agent') || '',
    req.get('Accept-Language') || '',
    req.get('Accept-Encoding') || '',
    req.get('Sec-CH-UA-Platform') || '',
    req.get('Sec-CH-UA-Mobile') || '',
  ].join('|');
}

export class DeviceFingerprint {
  // Generate unique device ID
  static generateFingerprint(req) {
    const cookieDeviceId = req.cookies?.deviceId;
    if (typeof cookieDeviceId === 'string' && cookieDeviceId.length > 0) {
      return cookieDeviceId;
    }

    const components = [
      buildStableFingerprintSeed(req),
    ].join('|');

    return crypto
      .createHash('sha256')
      .update(components)
      .digest('hex')
      .substring(0, 32); // Shorten for storage
  }

  static ensureFingerprint(req, res) {
    const existing = req.cookies?.deviceId;
    if (typeof existing === 'string' && existing.length > 0) {
      return existing;
    }

    const generated = crypto.randomUUID();
    if (res?.cookie) {
      res.cookie('deviceId', generated, deviceCookieOptions(req));
    }
    if (req.cookies) {
      req.cookies.deviceId = generated;
    }
    return generated;
  }

  // Get browser/device characteristics
  static getDeviceCharacteristics(req) {
    const ua = req.get('User-Agent') || '';
    
    return {
      browser: this.detectBrowser(ua),
      os: this.detectOS(ua),
      isMobile: /Mobile|Android|iPhone/i.test(ua),
      language: req.get('Accept-Language')?.split(',')[0] || 'unknown',
      fingerprint: this.generateFingerprint(req)
    };
  }

  static detectBrowser(ua) {
    if (/Chrome/.test(ua)) return 'Chrome';
    if (/Firefox/.test(ua)) return 'Firefox';
    if (/Safari/.test(ua)) return 'Safari';
    if (/Edge/.test(ua)) return 'Edge';
    return 'Unknown';
  }

  static detectOS(ua) {
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac OS/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    if (/Android/.test(ua)) return 'Android';
    if (/iPhone|iPad/.test(ua)) return 'iOS';
    return 'Unknown';
  }
}
