import type { Conversation } from '../../Chat/chatService';

export interface SignalDeviceIdentityRecord {
  userId: string;
  deviceId: string;
  registrationId: number;
  createdAt: string;
  updatedAt: string;
}

export interface SignalDmSessionRecord {
  userId: string;
  peerUserId: string;
  peerDeviceId: string;
  lastEstablishedAt: string;
  sessionVersion: number;
  sessionKey?: string | null; // legacy phase field
  rootKey?: string | null;
  sendChainKey?: string | null;
  receiveChainKey?: string | null;
  localRatchetPublicKey?: string | null;
  localRatchetPrivateKey?: string | null;
  remoteRatchetPublicKey?: string | null;
  previousChainLength?: number;
  pendingRatchet?: boolean;
  skippedMessageKeys?: string | null;
  sendCounter?: number;
  receiveCounter?: number;
}

export interface SignalGroupSenderKeyRecord {
  conversationId: string;
  senderDeviceId: string;
  senderKeyVersion: number;
  lastRotatedAt: string;
}

export interface SignalConversationBootstrapInput {
  userId: string;
  conversation: Conversation;
  peerUserId?: string;
}

export interface SignalBootstrapResult {
  enabled: boolean;
  ready: boolean;
  mode: 'legacy' | 'signal';
  reason?: string;
  deviceId?: string;
  missingServerRequirements?: string[];
}

export interface SignalServerCapabilities {
  supported: boolean;
  deviceRegistry: boolean;
  prekeyBundles: boolean;
  deviceMessageFanout: boolean;
  groupSenderKeys: boolean;
  membershipRotationHooks: boolean;
  reason?: string;
}

export interface SignalServerDeviceRecord {
  user_id: string;
  device_id: string;
  registration_id: number;
  identity_key?: string;
  signed_prekey_id?: number;
  signed_prekey_public_key?: string;
  signed_prekey_signature?: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface SignalLocalKeyPairRecord {
  publicKey: string;
  privateKey: string;
}

export interface SignalLocalOneTimePreKey {
  keyId: number;
  publicKey: string;
  privateKey: string;
  uploaded: boolean;
  usedAt?: string | null;
}

export interface SignalLocalBootstrapMaterial {
  userId: string;
  identityKey: SignalLocalKeyPairRecord;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    privateKey: string;
    signature: string;
  };
  oneTimePreKeys: SignalLocalOneTimePreKey[];
  nextPreKeyId: number;
  registrationUploaded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SignalEncryptedEnvelopePayload {
  protocol: 'void-signal-v1';
  version: number;
  mode: 'prekey' | 'signal';
  iv: string;
  ciphertext: string;
  counter?: number;
  previous_counter?: number;
  ratchet_public_key?: string;
  sender_identity_key?: string;
  signed_prekey_id?: number;
  one_time_prekey_id?: number | null;
  ephemeral_public_key?: string;
}

export interface SignalGroupSenderKeyPayload {
  kind: 'group_sender_key';
  conversation_id: string;
  key_version: number;
  group_key: string;
  sent_at: string;
}

export interface SignalDmMessageEnvelopeEntry {
  recipient_user_id: string;
  recipient_device_id: string;
  type: 'prekey' | 'signal';
  payload: SignalEncryptedEnvelopePayload;
}

export interface SignalDmMessagePayload {
  protocol: 'void-signal-v1';
  kind: 'dm_message';
  version: number;
  sender_user_id: string;
  sender_device_id: string;
  sent_at: string;
  envelopes: SignalDmMessageEnvelopeEntry[];
  fallback?: {
    encrypted_content: string;
    iv: string;
  };
}

export interface SignalPreparedConversationMessage {
  encrypted_content: string;
  iv: string;
  key_version: number;
  message_type: string;
}
