import crypto from 'crypto';

export class DeviceFingerprint {
  // Generate unique device ID
  static generateFingerprint(req) {
    const components = [
      req.ip,
      req.get('User-Agent') || '',
      req.get('Accept-Language') || '',
      req.get('Accept-Encoding') || '',
    ].join('|');

    return crypto
      .createHash('sha256')
      .update(components)
      .digest('hex')
      .substring(0, 32); // Shorten for storage
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