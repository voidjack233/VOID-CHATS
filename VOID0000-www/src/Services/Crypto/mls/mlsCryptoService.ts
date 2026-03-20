import {
  acceptAll,
  decodeMlsMessage,
  defaultAuthenticationService,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  mlsExporter,
  processPrivateMessage,
  processPublicMessage,
  zeroOutUint8Array,
  type ClientConfig,
  type ClientState,
  type CiphersuiteImpl,
} from 'ts-mls';
import { MLS_EXPORTER_LABEL, MlsCipherSuites } from './mlsTypes';
import { base64ToBytes } from './mlsUtils';

let implPromise: Promise<CiphersuiteImpl> | null = null;

export function getMlsCiphersuiteImpl(): Promise<CiphersuiteImpl> {
  if (!implPromise) {
    implPromise = getCiphersuiteImpl(getCiphersuiteFromName(MlsCipherSuites.default));
  }
  return implPromise;
}

export function buildMlsClientConfig(): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
  };
}

export async function deriveGroupAesKey(
  state: ClientState,
  conversationId: string,
  impl: CiphersuiteImpl,
): Promise<{ key: CryptoKey; keyVersion: number }> {
  const contextBytes = new TextEncoder().encode(conversationId);
  const keyBytes = await mlsExporter(
    state.keySchedule.exporterSecret,
    MLS_EXPORTER_LABEL,
    contextBytes,
    32,
    impl,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  return { key, keyVersion: Number(state.groupContext.epoch) };
}

export async function applyCommitMessage(
  state: ClientState,
  payload: string,
  impl: CiphersuiteImpl,
): Promise<ClientState | null> {
  const commitBytes = base64ToBytes(payload);
  const decoded = decodeMlsMessage(commitBytes, 0);
  if (!decoded) return null;

  const [msg] = decoded;
  if (msg.wireformat === 'mls_private_message') {
    const result = await processPrivateMessage(
      state,
      msg.privateMessage,
      emptyPskIndex,
      impl,
      acceptAll,
    );
    result.consumed.forEach(zeroOutUint8Array);
    return result.kind === 'newState' ? result.newState : null;
  }

  if (msg.wireformat === 'mls_public_message') {
    const result = await processPublicMessage(
      state,
      msg.publicMessage,
      emptyPskIndex,
      impl,
      acceptAll,
    );
    result.consumed.forEach(zeroOutUint8Array);
    return result.newState;
  }

  return null;
}
