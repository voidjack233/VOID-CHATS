// utils/securityUtils.js
import { pool } from '../db.js';
import { DeviceFingerprint } from './deviceFingerprint.js';

// Known malicious IP ranges
const SUSPICIOUS_NETWORKS = [
  '185.159.128.',
  '45.155.205.',
  '192.168.0.',
  '10.0.0.',
  '172.16.0.',
  '169.254.'
];

export function getClientIP(req) {
  let ip = req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    null;

  if (!ip) return null;

  if (ip === '::1') {
    return '127.0.0.1';
  }

  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }

  return ip;
}

// Helper: Generate fingerprint/device ID consistently
export function generateDeviceFingerprint(req) {
  return DeviceFingerprint.generateFingerprint(req);
}

export class IPSecurity {
  static async logIPActivity(req, action, userId = null, client = null) {
    try {
      const deviceFingerprint = generateDeviceFingerprint(req);
      const ipAddress = getClientIP(req);

      const query = `
        INSERT INTO ip_security_logs 
        (ip_address, action, user_id, user_agent, device_fingerprint, path, created_at) 
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `;
      const params = [
        ipAddress,
        action,
        userId,
        req.get('User-Agent') || null,
        deviceFingerprint,
        req.path || req.originalUrl || null
      ];

      if (client) {
        await client.query(query, params);
      } else {
        await pool.query(query, params);
      }

      return true;
    } catch (err) {
      console.error('IP logging error:', err);
      return false;
    }
  }

  // Use the shared function
  static generateFingerprint(req) {
    return generateDeviceFingerprint(req);
  }

  static async hasExcessiveFailures(ip, threshold = 10, client = null) {
    try {
      const query = `
        SELECT COUNT(*) as failure_count FROM ip_security_logs 
        WHERE ip_address = $1 AND action IN ('AUTH_FAILURE', 'LOGIN_FAILURE') 
        AND created_at > NOW() - INTERVAL '1 hour'
      `;

      if (client) {
        const result = await client.query(query, [ip]);
        return parseInt(result.rows[0].failure_count) >= threshold;
      } else {
        const result = await pool.query(query, [ip]);
        return parseInt(result.rows[0].failure_count) >= threshold;
      }
    } catch (err) {
      console.error('Failure check error:', err);
      return false;
    }
  }

  static async hasExcessiveDeviceFailures(fingerprint, threshold = 5, client = null) {
    try {
      const query = `
        SELECT COUNT(*) as failure_count FROM ip_security_logs 
        WHERE device_fingerprint = $1 AND action IN ('AUTH_FAILURE', 'LOGIN_FAILURE') 
        AND created_at > NOW() - INTERVAL '1 hour'
      `;

      if (client) {
        const result = await client.query(query, [fingerprint]);
        return parseInt(result.rows[0].failure_count) >= threshold;
      } else {
        const result = await pool.query(query, [fingerprint]);
        return parseInt(result.rows[0].failure_count) >= threshold;
      }
    } catch (err) {
      console.error('Device failure check error:', err);
      return false;
    }
  }

  static isSuspiciousIP(ip) {
    if (!ip) return true;

    for (const network of SUSPICIOUS_NETWORKS) {
      if (ip.startsWith(network)) {
        return true;
      }
    }

    if (process.env.NODE_ENV === 'production' &&
      (ip === '127.0.0.1' || ip === '::1')) {
      return true;
    }

    return false;
  }

  static async getIPStats(ip, hours = 24, client = null) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_requests,
          COUNT(DISTINCT action) as unique_actions,
          MIN(created_at) as first_seen,
          MAX(created_at) as last_seen
        FROM ip_security_logs 
        WHERE ip_address = $1 
        AND created_at > NOW() - INTERVAL '${hours} hours'
      `;

      if (client) {
        const result = await client.query(query, [ip]);
        return result.rows[0];
      } else {
        const result = await pool.query(query, [ip]);
        return result.rows[0];
      }
    } catch (err) {
      console.error('IP stats error:', err);
      return null;
    }
  }
}

export class DeviceManager {
  /**
   * Update device info for ALL tokens from this device
   * This should be called AFTER token is created in login.js
   */
  static async registerDevice(userId, req, client = null) {
    try {
      const deviceId = this.generateDeviceId(req);
      const userAgent = req.get('User-Agent') || 'Unknown';
      const ipAddress = getClientIP(req);
      const deviceInfo = this.getDeviceInfo(req);
      
      // UPDATE existing device records for this user+device
      const query = `
        UPDATE refresh_tokens 
        SET 
          device_name = COALESCE(NULLIF(device_name, ''), $1),
          device_type = COALESCE(NULLIF(device_type, ''), $2),
          ip_address = $3,
          user_agent = $4,
          last_used_at = NOW()
        WHERE user_id = $5 
          AND device_id = $6
          AND is_revoked = FALSE
      `;
      
      const params = [
        deviceInfo.deviceName,
        deviceInfo.deviceType,
        ipAddress,
        userAgent,
        userId,
        deviceId
      ];

      if (client) {
        await client.query(query, params);
      } else {
        await pool.query(query, params);
      }

      return {
        deviceId,
        deviceName: deviceInfo.deviceName,
        deviceType: deviceInfo.deviceType,
        ipAddress,
        userAgent
      };
      
    } catch (err) {
      console.error('Device registration error:', err);
      return null;
    }
  }

  /**
   * Generate a unique device identifier
   * Uses same method as IPSecurity.generateFingerprint for consistency
   */
  static generateDeviceId(req, res = null) {
    if (res) {
      return DeviceFingerprint.ensureFingerprint(req, res);
    }

    return generateDeviceFingerprint(req);
  }

  /**
   * Extract device information from request
   */
  static getDeviceInfo(req) {
    const ua = req.get('User-Agent') || '';

    // Determine device type
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipod/i.test(ua)) {
      deviceType = 'mobile';
    } else if (/tablet|ipad/i.test(ua)) {
      deviceType = 'tablet';
    }

    // Extract device name from User-Agent
    let deviceName = 'Unknown Device';
    if (/iPhone/i.test(ua)) deviceName = 'iPhone';
    else if (/iPad/i.test(ua)) deviceName = 'iPad';
    else if (/Macintosh|Mac OS/i.test(ua)) deviceName = 'Mac';
    else if (/Windows/i.test(ua)) deviceName = 'Windows PC';
    else if (/Android/i.test(ua)) deviceName = 'Android Device';
    else if (/Linux/i.test(ua)) deviceName = 'Linux PC';
    else if (/Chrome/i.test(ua)) deviceName = 'Chrome Browser';
    else if (/Firefox/i.test(ua)) deviceName = 'Firefox Browser';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) deviceName = 'Safari Browser';

    // Allow frontend to override device name (optional)
    if (req.body.deviceName && req.body.deviceName.trim()) {
      const customName = req.body.deviceName.trim();
      if (customName.length <= 100) {
        deviceName = customName;
      }
    }

    return {
      deviceName,
      deviceType,
      userAgent: ua
    };
  }

  /**
   * Get all devices for a user
   */
  static async getUserDevices(userId, client = null) {
    try {
      const query = `
        SELECT DISTINCT ON (device_id)
          device_id,
          device_name,
          device_type,
          ip_address,
          user_agent,
          MAX(last_used_at) as last_active,
          COUNT(*) as session_count
        FROM refresh_tokens 
        WHERE user_id = $1 
          AND device_id IS NOT NULL
          AND is_revoked = FALSE
        GROUP BY device_id, device_name, device_type, ip_address, user_agent
        ORDER BY device_id, last_active DESC
      `;

      let result;
      if (client) {
        result = await client.query(query, [userId]);
      } else {
        result = await pool.query(query, [userId]);
      }

      return result.rows;
    } catch (err) {
      console.error('Get devices error:', err);
      return [];
    }
  }

  /**
   * Block/revoke a specific device
   */
  static async blockDevice(userId, deviceId, client = null) {
    try {
      const query = `
        UPDATE refresh_tokens 
        SET is_revoked = TRUE,
            revoked_at = NOW(),
            revoked_by = $1
        WHERE user_id = $1 
          AND device_id = $2
          AND is_revoked = FALSE
      `;

      if (client) {
        await client.query(query, [userId, deviceId]);
      } else {
        await pool.query(query, [userId, deviceId]);
      }

      return true;
    } catch (err) {
      console.error('Block device error:', err);
      return false;
    }
  }

  /**
   * Rename a device
   */
  static async renameDevice(userId, deviceId, newName, client = null) {
    try {
      if (!newName || newName.trim().length === 0 || newName.length > 100) {
        return false;
      }

      const query = `
        UPDATE refresh_tokens 
        SET device_name = $1
        WHERE user_id = $2 
          AND device_id = $3
          AND is_revoked = FALSE
      `;

      if (client) {
        await client.query(query, [newName.trim(), userId, deviceId]);
      } else {
        await pool.query(query, [newName.trim(), userId, deviceId]);
      }

      return true;
    } catch (err) {
      console.error('Rename device error:', err);
      return false;
    }
  }

  /**
   * Get device statistics for a user
   */
  static async getDeviceStats(userId, client = null) {
    try {
      const query = `
        SELECT 
          COUNT(DISTINCT device_id) as total_devices,
          COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN device_id END) as mobile_devices,
          COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN device_id END) as desktop_devices,
          COUNT(DISTINCT CASE WHEN device_type = 'tablet' THEN device_id END) as tablet_devices,
          MIN(last_used_at) as first_device_seen,
          MAX(last_used_at) as last_device_activity
        FROM refresh_tokens 
        WHERE user_id = $1 
          AND device_id IS NOT NULL
          AND is_revoked = FALSE
      `;

      let result;
      if (client) {
        result = await client.query(query, [userId]);
      } else {
        result = await pool.query(query, [userId]);
      }

      return result.rows[0] || {
        total_devices: 0,
        mobile_devices: 0,
        desktop_devices: 0,
        tablet_devices: 0
      };
    } catch (err) {
      console.error('Get device stats error:', err);
      return null;
    }
  }
}
