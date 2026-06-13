export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  [key: string]: any;
}

export type KeyStatus = 'SECURE' | 'LOCKED' | 'UNINITIALIZED';
export type RecoveryBackupStatus = 'RECOVERY_KEY_READY' | 'PASSWORD_ONLY' | 'UNINITIALIZED';

export type MlsRecoveryGateReason =
  | 'recovery_key_required'
  | 'password_required'
  | 'restore_failed'
  | 'local_state_lost';

export interface MlsRecoveryGateState {
  active: boolean;
  reason: MlsRecoveryGateReason | null;
}

export interface UserContextType {
  user: User | null;
  loading: boolean;
  authUnavailable: boolean;
  authRetrying: boolean;
  keyStatus: KeyStatus;
  recoveryBackupStatus: RecoveryBackupStatus;
  keyStatusLoading: boolean;
  mlsRecoveryGate: MlsRecoveryGateState;
  isLoggingOut: boolean;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  verifySession: () => Promise<'authenticated' | 'invalid' | 'unavailable'>;
  retryAuth: () => Promise<void>;
  refreshKeyStatus: () => Promise<KeyStatus>;
  logout: () => Promise<void>;
  setLoginPassword: (password: string) => void;
  refreshSecureBackupsWithPassword: (password: string) => Promise<void>;
  generateRecoveryKey: () => string;
  continueWithoutLocalSecureHistory: () => void;
  setupRecoveryKey: (recoveryKey: string) => Promise<void>;
  retryMlsRecoveryWithRecoveryKey: (recoveryKey: string) => Promise<void>;
  retryMlsRecoveryWithPassword: (password: string) => Promise<void>;
}
