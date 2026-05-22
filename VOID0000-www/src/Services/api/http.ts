import { fetchWithAuth } from '../Auth/authServiceApi';

export interface ApiRequestOptions extends RequestInit {
  source?: string;
}

export interface ApiJsonOptions extends ApiRequestOptions {
  fallbackMessage?: string;
}

export interface ApiError extends Error {
  status?: number;
  statusCode?: number;
  retryAfterMs?: number | null;
  [key: string]: unknown;
}

function getRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) return null;

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfter);
  if (Number.isFinite(retryAfterDate)) {
    return Math.max(0, retryAfterDate - Date.now());
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getErrorMessage(data: unknown, fallbackMessage: string): string {
  if (!isRecord(data)) return fallbackMessage;

  return (
    (typeof data.error === 'string' && data.error.trim()) ||
    (typeof data.message === 'string' && data.message.trim()) ||
    (typeof data.code === 'string' && data.code.trim()) ||
    fallbackMessage
  );
}

export function createApiError(
  data: unknown,
  fallbackMessage = 'Request failed',
  meta: Record<string, unknown> = {},
): ApiError {
  const error = new Error(getErrorMessage(data, fallbackMessage)) as ApiError;

  if (isRecord(data)) {
    Object.assign(error, data);
  }

  Object.assign(error, meta);
  return error;
}

export async function apiRequest(url: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { source, ...requestOptions } = options;
  const method = (requestOptions.method || 'GET').toString().toUpperCase();

  if (import.meta.env.DEV) {
    console.debug(`[API] ${method} ${url}${source ? ` <- ${source}` : ''}`);
  }

  return fetchWithAuth(url, requestOptions);
}

export async function parseApiJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const text = await response.text().catch(() => '');
    return text ? { message: text } : null;
  }

  return response.json().catch(() => null);
}

export async function apiJson<T = unknown>(
  url: string,
  options: ApiJsonOptions = {},
): Promise<T> {
  const { fallbackMessage = 'Request failed', ...requestOptions } = options;
  const response = await apiRequest(url, requestOptions);
  const data = await parseApiJson(response);

  if (!response.ok || (isRecord(data) && data.success === false)) {
    throw createApiError(data, fallbackMessage, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMs(response),
    });
  }

  return data as T;
}
