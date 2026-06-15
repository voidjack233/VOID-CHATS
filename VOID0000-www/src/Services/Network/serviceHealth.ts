export interface ServiceIssue {
  service: string;
  url: string;
  status?: number;
  message: string;
  lastSeenAt: number;
}

export interface ServiceHealthSnapshot {
  hasIssues: boolean;
  issues: ServiceIssue[];
  updatedAt: number;
}

type Listener = (snapshot: ServiceHealthSnapshot) => void;

const listeners = new Set<Listener>();
const issues = new Map<string, ServiceIssue>();

let snapshot: ServiceHealthSnapshot = {
  hasIssues: false,
  issues: [],
  updatedAt: Date.now(),
};

function getPathname(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url;
  }
}

function getServiceName(url: string): string {
  const pathname = getPathname(url);

  if (
    /^\/api\/conversations\/[^/]+\/messages/.test(pathname) ||
    /^\/api\/conversations\/[^/]+\/reactions/.test(pathname) ||
    /^\/api\/conversations\/[^/]+\/attachments/.test(pathname)
  ) {
    return 'Message service';
  }

  if (pathname.startsWith('/api/bootstrap') || pathname.startsWith('/api/conversations')) {
    return 'Conversation service';
  }

  if (
    pathname.startsWith('/api/friends') ||
    pathname.startsWith('/api/users/search') ||
    pathname.startsWith('/api/users/profile') ||
    /^\/api\/users\/[^/]+$/.test(pathname)
  ) {
    return 'Social service';
  }

  return 'Account service';
}

function buildMessage(service: string, status?: number): string {
  if (status === 401) {
    return `${service} rejected the request (401). Your session may need to be refreshed.`;
  }

  if (status === 403) {
    return `${service} rejected the request (403). You may not have access to that action.`;
  }

  if (status === 429) {
    return `${service} is receiving too many requests (429). Please wait and try again.`;
  }

  if (status) {
    return `${service} returned ${status}. Some actions may fail until it recovers.`;
  }

  return `${service} is unreachable. Retrying when it comes back.`;
}

function shouldReportStatus(status: number): boolean {
  return status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
}

function publish() {
  snapshot = {
    hasIssues: issues.size > 0,
    issues: Array.from(issues.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    updatedAt: Date.now(),
  };

  listeners.forEach((listener) => listener(snapshot));
}

export function getServiceHealthSnapshot(): ServiceHealthSnapshot {
  return snapshot;
}

export function subscribeServiceHealth(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

export function reportApiResponse(url: string, status: number): void {
  const service = getServiceName(url);

  if (shouldReportStatus(status)) {
    issues.set(service, {
      service,
      url,
      status,
      message: buildMessage(service, status),
      lastSeenAt: Date.now(),
    });
    publish();
    return;
  }

  if (issues.delete(service)) {
    publish();
  }
}

export function reportApiNetworkFailure(url: string): void {
  const service = getServiceName(url);
  issues.set(service, {
    service,
    url,
    message: buildMessage(service),
    lastSeenAt: Date.now(),
  });
  publish();
}
