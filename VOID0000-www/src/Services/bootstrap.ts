import { fetchWithAuth } from './Auth/authServiceApi';

export interface AppBootstrap {
  success: true;
  user: any;
  account: any;
  preferences: any | null;
  friends: any[];
  friend_requests: {
    incoming: any[];
    outgoing: any[];
  };
  conversations: any[];
}

let cachedBootstrap: AppBootstrap | null = null;
let bootstrapPromise: Promise<AppBootstrap | null> | null = null;

export function getCachedAppBootstrap(): AppBootstrap | null {
  return cachedBootstrap;
}

export function clearAppBootstrap(): void {
  cachedBootstrap = null;
  bootstrapPromise = null;
}

export async function fetchAppBootstrap(force = false): Promise<AppBootstrap | null> {
  if (!force && cachedBootstrap) {
    return cachedBootstrap;
  }

  if (!force && bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      const response = await fetchWithAuth('/api/bootstrap');
      if (!response.ok) return null;

      const data = await response.json();
      if (!data?.success) return null;

      cachedBootstrap = data as AppBootstrap;
      return cachedBootstrap;
    } catch (error) {
      console.warn('Failed to fetch app bootstrap:', error);
      return null;
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}
