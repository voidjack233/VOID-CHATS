import { API_URL } from '../config';
import { reportApiNetworkFailure, reportApiResponse } from '../Network/serviceHealth';

// ============== TYPES ==============
interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  is_verified?: boolean;
  [key: string]: any;
}

interface CaptchaData {
  captchaId: string;
  captchaAnswer: string;
}

interface ApiResponse {
  success: boolean;
  message?: string;
  token?: string;
  verificationToken?: string;
  twoFactorToken?: string;
  user?: User;
  csrfToken?: string;
  code?: string;
  resetTime?: number;
  email?: string;
  codeSent?: boolean;
  cooldown?: number;
  attemptsLeft?: number;
  retryAfterMs?: number;
  cooldownUntil?: number;
  retryAfterSeconds?: number;
}

// ============== STATE ==============
let csrfToken: string | null = null;
let isLoggingOut = false;

type RefreshFailureKind = 'invalid' | 'unavailable';

interface RefreshResult {
  success: boolean;
  failureKind?: RefreshFailureKind;
  code?: string;
  status?: number;
}

const DEFINITIVE_REFRESH_FAILURE_CODES = new Set([
  'NO_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'DEVICE_MISMATCH',
]);

let refreshPromise: Promise<RefreshResult> | null = null;
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_ERROR_PATTERN = /\b(csrf|xsrf|forgery)\b|token validation failed/i;

export class AuthSessionUnavailableError extends Error {
  readonly code = 'AUTH_SESSION_UNAVAILABLE';

  constructor(message = 'The server is unavailable. Your session will be retried.') {
    super(message);
    this.name = 'AuthSessionUnavailableError';
  }
}

export function isAuthSessionUnavailableError(error: unknown): error is AuthSessionUnavailableError {
  return error instanceof AuthSessionUnavailableError ||
    (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'AUTH_SESSION_UNAVAILABLE'
    );
}

async function readJsonSafely(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.clone().json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getRetryAfterMs(response: Response, payload: Record<string, unknown>): number | null {
  const retryAfterMs = Number(payload.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }

  const cooldownUntil = Number(payload.cooldownUntil);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return cooldownUntil - Date.now();
  }

  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfter);
  return Number.isFinite(retryAfterDate)
    ? Math.max(0, retryAfterDate - Date.now())
    : null;
}

function isMutationMethod(method?: string): boolean {
  if (!method) return false;
  return !SAFE_HTTP_METHODS.has(method.toUpperCase());
}

function containsCSRFSignal(value: unknown): boolean {
  if (typeof value === 'string') {
    return CSRF_ERROR_PATTERN.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(containsCSRFSignal);
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsCSRFSignal);
  }

  return false;
}

async function isLikelyCSRFError(response: Response): Promise<boolean> {
  if (![400, 403, 419].includes(response.status)) {
    return false;
  }

  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = await response.clone().json();
      return containsCSRFSignal(payload);
    }

    const textPayload = await response.clone().text();
    return containsCSRFSignal(textPayload);
  } catch {
    return false;
  }
}

// ============== CSRF ==============
async function getCSRFToken(): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/api/csrf/csrf-token`, {
      method: 'GET',
      credentials: 'include',
    });
    const data = await response.json();

    if (data.success && data.csrfToken) {
      csrfToken = data.csrfToken;
      return csrfToken;
    }
    return null;
  } catch (err) {
    console.error('Failed to fetch CSRF token:', err);
    return null;
  }
}

async function ensureCSRFToken(): Promise<string | null> {
  if (!csrfToken) {
    return await getCSRFToken();
  }
  return csrfToken;
}

function clearCSRFToken(): void {
  csrfToken = null;
}

// ============== TOKEN REFRESH ==============
async function doRefresh(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshUrl = `${API_URL}/api/auth/refresh`;

    try {
      const response = await fetch(refreshUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      reportApiResponse(refreshUrl, response.status);

      if (response.ok) {
        return { success: true, status: response.status };
      }

      const payload = await readJsonSafely(response);
      const code = typeof payload.code === 'string' ? payload.code : undefined;
      return {
        success: false,
        failureKind: code && DEFINITIVE_REFRESH_FAILURE_CODES.has(code)
          ? 'invalid'
          : 'unavailable',
        code,
        status: response.status,
      };
    } catch {
      reportApiNetworkFailure(refreshUrl);
      return {
        success: false,
        failureKind: 'unavailable',
      };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ============== FETCH WRAPPER ==============
async function fetchWithAuth(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
  const method = options.method?.toUpperCase() || 'GET';
  const needsCSRFToken = isMutationMethod(method);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (needsCSRFToken) {
    const token = await ensureCSRFToken();
    if (token) {
      headers['X-CSRF-Token'] = token;
    }
  }

  const performRequest = async () => {
    try {
      const response = await fetch(fullUrl, {
        ...options,
        credentials: 'include',
        headers,
      });
      return response;
    } catch (err) {
      reportApiNetworkFailure(fullUrl);
      throw err;
    }
  };

  let response = await performRequest();

  if (response.status === 401 && !isLoggingOut) {
    const refreshResult = await doRefresh();

    if (refreshResult.success) {
      clearCSRFToken();
      const newCsrfToken = await getCSRFToken();
      if (newCsrfToken && needsCSRFToken) {
        headers['X-CSRF-Token'] = newCsrfToken;
      }

      response = await performRequest();
    } else if (refreshResult.failureKind === 'unavailable') {
      throw new AuthSessionUnavailableError();
    }
  }

  // Some backends rotate CSRF secrets during membership/session transitions.
  // If we detect CSRF validation, or any mutation returns 403, refresh once.
  if (needsCSRFToken && ((await isLikelyCSRFError(response)) || response.status === 403)) {
    clearCSRFToken();
    const newCsrfToken = await getCSRFToken();
    if (newCsrfToken) {
      headers['X-CSRF-Token'] = newCsrfToken;
      response = await performRequest();
    }
  }

  reportApiResponse(fullUrl, response.status);
  return response;
}

// ============== AUTH SERVICE ==============
export const authService = {
  // ---------- AUTH STATUS ----------
  async checkAuthStatus(): Promise<boolean> {
    try {
      const response = await fetchWithAuth('/api/me');
      return response.ok;
    } catch {
      return false;
    }
  },

  async getCurrentUser(): Promise<User | null> {
    try {
      const response = await fetchWithAuth('/api/me');
      if (!response.ok) return null;

      const data = await response.json();

      if (data.user) {
        await ensureCSRFToken();
      }

      return data.user ?? null;
    } catch {
      return null;
    }
  },

  async verifyAuthWithRefresh(): Promise<{ authenticated: boolean; user: User | null; networkError?: boolean }> {
    try {
      const response = await fetchWithAuth('/api/me');
      if (!response.ok) {
        return { authenticated: false, user: null };
      }

      const data = await response.json();

      if (data.user) {
        await ensureCSRFToken();
      }

      return { authenticated: true, user: data.user ?? null };
    } catch (err) {
      if (isAuthSessionUnavailableError(err)) {
        return { authenticated: false, user: null, networkError: true };
      }
      return { authenticated: false, user: null, networkError: true };
    }
  },

  // ---------- CAPTCHA ----------
  async checkCaptchaRequired(action: string = 'login'): Promise<{ captchaRequired: boolean }> {
    try {
      const response = await fetch(`${API_URL}/api/captcha/check?action=${action}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return { captchaRequired: data.captchaRequired ?? true };
    } catch {
      return { captchaRequired: true };
    }
  },

  // ---------- LOGIN / LOGOUT ----------
  async login(credentials: { identifier: string; password: string } & Partial<CaptchaData>): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        const payload = data && typeof data === 'object'
          ? data as Record<string, unknown>
          : {};
        const retryAfterMs = getRetryAfterMs(response, payload);
        const cooldownUntil = Number(payload.cooldownUntil);
        throw {
          ...payload,
          retryAfterMs: retryAfterMs ?? undefined,
          cooldownUntil: Number.isFinite(cooldownUntil) && cooldownUntil > 0
            ? cooldownUntil
            : retryAfterMs
              ? Date.now() + retryAfterMs
              : undefined,
        };
      }
      throw data;
    }

    await getCSRFToken();

    return data;
  },

  async logout(): Promise<void> {
    isLoggingOut = true;

    try {
      const token = await ensureCSRFToken();

      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'X-CSRF-Token': token })
        }
      });
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      clearCSRFToken();
      localStorage.clear();
      sessionStorage.clear();
      isLoggingOut = false;
    }
  },

  async refreshToken(): Promise<boolean> {
    const result = await doRefresh();
    return result.success;
  },

  // ---------- REGISTER ----------
  async register(userData: { username: string; email: string; password: string } & Partial<CaptchaData>): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
      credentials: 'include',
    });
    return await response.json();
  },

  // ---------- EMAIL VERIFICATION ----------
  async validateToken(vtoken: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/validate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vtoken }),
      credentials: 'include',
    });
    return await response.json();
  },

  async sendVerificationCode(vtoken: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vtoken, ...captcha }),
      credentials: 'include',
    });
    return await response.json();
  },

  async verifyEmail(code: string, vtoken: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, token: vtoken }),
      credentials: 'include',
    });
    return await response.json();
  },

  async resendVerification(email: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/resend-email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...captcha }),
      credentials: 'include',
    });
    return response.json();
  },

  // ---------- PASSWORD RESET (PUBLIC) ----------
  async forgotPassword(email: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...captcha }),
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok) {
      throw data;
    }

    return data;
  },

  async resetPassword(token: string, newPassword: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
      credentials: 'include',
    });
    return await response.json();
  },

  async checkResetToken(token: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/check-reset-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'include',
    });
    return await response.json();
  },

  // ---------- PASSWORD CHANGE (AUTHENTICATED + CSRF) ----------
  async changePassword(
    currentPassword: string,
    newPassword: string,
    keyBackup?: {
      encrypted_private_key: string;
      iv: string;
      salt: string;
      key_id: string;
      mls_state_encrypted?: string;
      mls_state_iv?: string;
      mls_state_salt?: string;
      mls_key_package_refs?: string[];
    } | null,
    twoFactor?: {
      method: string;
      code: string;
    } | null,
  ): Promise<ApiResponse> {
    const response = await fetchWithAuth('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword,
        newPassword,
        keyBackup: keyBackup || null,
        twoFactorMethod: twoFactor?.method || null,
        twoFactorCode: twoFactor?.code || null,
      }),
    });
    const result = await response.json();

    if (result.success) {
      clearCSRFToken();
      await getCSRFToken();
    }

    return result;
  },

  // ---------- 2FA ----------
  async get2FAStatus(): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/status');
    return res.json();
  },

  async setupTOTP(password: string): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/setup-totp', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return res.json();
  },

  async setupEmail2FA(password: string): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/setup-email', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return res.json();
  },

  async verifySetup2FA(method: string, code: string): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/verify-setup', {
      method: 'POST',
      body: JSON.stringify({ method, code }),
    });
    return res.json();
  },

  async verify2FALogin(twoFactorToken: string, code: string, method: string): Promise<ApiResponse> {
    const res = await fetch(`${API_URL}/api/auth/2fa/verify-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twoFactorToken, code, method }),
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) throw data;
    await getCSRFToken();
    return data;
  },

  async send2FAEmailCode(twoFactorToken: string): Promise<any> {
    const res = await fetch(`${API_URL}/api/auth/2fa/verify-login/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twoFactorToken }),
      credentials: 'include',
    });
    return res.json();
  },

  async sendAuthenticated2FAEmailCode(action: 'change_password'): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/send-action-email', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    return res.json();
  },

  async disable2FA(method: string, password: string): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ method, password }),
    });
    return res.json();
  },

  async regenerateBackupCodes(password: string): Promise<any> {
    const res = await fetchWithAuth('/api/auth/2fa/backup-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return res.json();
  },
};

export { fetchWithAuth, ensureCSRFToken, clearCSRFToken };
