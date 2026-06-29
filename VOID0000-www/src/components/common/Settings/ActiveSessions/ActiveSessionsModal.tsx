import { X, Monitor, Smartphone, Globe, Loader2, Shield } from 'lucide-react';
import { useActiveSessions } from '../../../../Services/hooks/Settings/useActiveSessions';
import { useState, useEffect } from 'react';
import { SessionCardSkeleton } from '../../Skeleton';

interface ActiveSessionsModalProps {
  onClose: () => void;
}

interface DeviceInfo {
  isPhone: boolean;
  browser: string;
  os: string;
  icon: React.ComponentType<{ className?: string }>;
  deviceType: 'Phone' | 'Tablet' | 'Desktop' | 'Unknown';
}

const parseUserAgent = (ua: string | null): DeviceInfo => {
  if (!ua) {
    return {
      isPhone: false,
      browser: 'Unknown',
      os: 'Unknown',
      icon: Monitor,
      deviceType: 'Unknown'
    };
  }

  const isPhone = /mobile|android|iphone/i.test(ua);
  const isTablet = /tablet|ipad/i.test(ua);
  
  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Brave)\/[\d.]+/i);
  const browser = browserMatch?.[0]?.split('/')[0] || 'Unknown Browser';
  
  const osMatch = ua.match(/(Windows|Mac|Linux|Android|iOS|iPhone)/i);
  const os = osMatch?.[0] || 'Unknown OS';
  
  let deviceType: DeviceInfo['deviceType'] = 'Desktop';
  let icon: DeviceInfo['icon'] = Monitor;
  
  if (isPhone) {
    deviceType = 'Phone';
    icon = Smartphone;
  } else if (isTablet) {
    deviceType = 'Tablet';
    icon = Smartphone;
  }
  
  return { isPhone, browser, os, icon, deviceType };
};

const formatDate = (dateString: string, isMobile: boolean = false) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (isMobile) {
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
  }
  
  if (diffDays === 0) {
    return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays === 1) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export default function ActiveSessionsModal({ onClose }: ActiveSessionsModalProps) {
  const { sessions, loading, error, revoking, revokeSession, revokeAllSessions } = useActiveSessions();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const otherSessions = sessions.filter(s => !s.is_current);
  const currentSession = sessions.find(s => s.is_current);

  return (
    <div className={`fixed inset-0 z-50 ${isMobile ? 'bg-void-bg-main' : 'flex items-center justify-center bg-black/50 backdrop-blur-sm'}`}>
      <div className={`${isMobile 
        ? 'h-full w-full flex flex-col' 
        : 'bg-void-bg-sec border border-void-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-hidden flex flex-col'
      }`}>
        
        {/* Header */}
        <div className={`${isMobile 
          ? 'sticky top-0 z-10 bg-void-bg-sec border-b border-void-border px-4 py-3'
          : 'p-6 border-b border-void-border'
        } flex items-center justify-between`}>
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-void-accent mt-0.5" />
            <div>
              <h3 className="text-lg font-semibold text-void-text">Active Sessions</h3>
              <p className="text-xs text-void-text-muted mt-1">
                One entry per signed-in device or browser.
              </p>
            </div>
          </div>
          
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-void-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-void-text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          
          {/* Loading State */}
          {loading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <SessionCardSkeleton key={i} />)}
            </div>
          )}
          
          {/* Error State */}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-16 h-16 rounded-full bg-red-900/20 flex items-center justify-center mb-4">
                <Shield className="w-8 h-8 text-red-400" />
              </div>
              <h4 className="text-lg font-medium text-void-text mb-2">Connection Error</h4>
              <p className="text-red-400 text-sm text-center mb-6 max-w-xs">{error}</p>
              <button
                onClick={onClose}
                className="px-6 py-2.5 bg-void-bg-hover hover:bg-void-bg-hover/80 rounded-lg text-void-text text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          )}
          
          {/* Sessions List */}
          {!loading && !error && (
            <div className="space-y-4">
              
              {/* Current Session */}
              {currentSession && (
                <div className="mb-6">
                  <h4 className="text-sm text-void-text-muted mb-3">Current session</h4>
                  <SessionCard 
                    session={currentSession} 
                    isCurrent={true}
                    isMobile={isMobile}
                  />
                </div>
              )}

              {/* Other Sessions */}
              {otherSessions.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm text-void-text-muted">
                      Other sessions ({otherSessions.length})
                    </h4>
                    <button
                      onClick={revokeAllSessions}
                      disabled={revoking !== null}
                      className="text-xs px-3 py-1.5 bg-red-900/20 hover:bg-red-900/30 rounded-lg text-red-400 disabled:opacity-50 transition-colors"
                    >
                      {revoking === '__all__' ? 'Revoking...' : 'Revoke all'}
                    </button>
                  </div>

                  <div className="space-y-3">
                    {otherSessions.map(session => (
                      <SessionCard 
                        key={session.id}
                        session={session} 
                        isCurrent={false}
                        isMobile={isMobile}
                        onRevoke={() => revokeSession(session.id)}
                        isRevoking={revoking === session.id}
                        disabled={revoking !== null}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Empty State */}
              {otherSessions.length === 0 && (
                <div className="text-center py-8">
                  <div className="inline-block p-6 bg-void-bg-main/55 rounded-xl border border-void-border">
                    <Shield className="w-12 h-12 text-void-text-muted mx-auto mb-3" />
                    <p className="text-void-text-muted mb-2">No other active sessions</p>
                    <p className="text-xs text-void-text-muted">Only this device or browser is currently signed in.</p>
                  </div>
                </div>
              )}

              {/* Footer info */}
              <div className={`${isMobile ? 'pt-6 pb-8' : 'pt-4'}`}>
                <p className="text-xs text-void-text-muted text-center">
                  Sessions expire after 7 days of inactivity
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Session Card Component
interface SessionCardProps {
  session: {
    id: string;
    device_id: string;
    device_name: string | null;
    device_type: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
    updated_at: string;
    last_live_at?: string | null;
    has_live_session?: boolean;
    is_recently_active?: boolean;
  };
  isCurrent: boolean;
  isMobile: boolean;
  onRevoke?: () => void;
  isRevoking?: boolean;
  disabled?: boolean;
}

function SessionCard({ session, isCurrent, isMobile, onRevoke, isRevoking, disabled }: SessionCardProps) {
  const device = parseUserAgent(session.user_agent);
  const DeviceIcon = device.icon;
  const deviceLabel = session.device_name?.trim() || (isMobile ? device.browser : `${device.browser} on ${device.os}`);

  return (
    <div className={`p-4 rounded-xl border ${
      isCurrent 
        ? 'bg-green-900/20 border-green-700/50' 
        : 'bg-void-bg-main/60 border-void-border'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${isCurrent ? 'bg-green-900/30' : 'bg-void-bg-hover'}`}>
          <DeviceIcon className={`w-5 h-5 ${isCurrent ? 'text-green-400' : 'text-void-text-muted'}`} />
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-void-text">
              {deviceLabel}
            </p>
            {isCurrent && (
              <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded-full">
                Current
              </span>
            )}
            {!isCurrent && session.is_recently_active && (
              <span className="px-2 py-0.5 bg-void-accent/15 text-void-accent text-xs rounded-full">
                Recent
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2 mt-1 text-xs text-void-text-muted">
            <Globe className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{session.ip_address || 'Unknown IP'}</span>
          </div>

          <div className="flex items-center gap-2 mt-1 text-xs text-void-text-muted flex-wrap">
            <span className="flex-shrink-0">Created {formatDate(session.created_at, isMobile)}</span>
            <span className="text-void-text-muted">•</span>
            <span className="flex-shrink-0">Last active {formatDate(session.updated_at, isMobile)}</span>
          </div>
        </div>
        
        {!isCurrent && onRevoke && (
          <button
            onClick={onRevoke}
            disabled={disabled}
            className="px-3 py-1.5 text-xs bg-red-900/20 hover:bg-red-900/30 rounded-lg text-red-400 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            {isRevoking ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              'Revoke'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
