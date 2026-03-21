import {
  bytesToBase64,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  generateKeyPackage,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type CredentialBasic,
  type LeafIndex,
  type LeafNode,
  type PrivateKeyPackage,
  type Proposal,
} from 'ts-mls';
import { fetchUserKeyPackage } from './mlsApi';
import type { AddProposalBuildResult, MlsKeyPackageRecord } from './mlsTypes';
import { MlsProtocolVersions } from './mlsTypes';
import { base64ToBytes } from './mlsUtils';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createBasicCredential(userId: string): CredentialBasic {
  return {
    credentialType: 'basic',
    identity: textEncoder.encode(userId),
  };
}

export function serializePrivatePackage(priv: PrivateKeyPackage): string {
  return btoa(
    JSON.stringify({
      initPrivateKey: bytesToBase64(priv.initPrivateKey),
      hpkePrivateKey: bytesToBase64(priv.hpkePrivateKey),
      signaturePrivateKey: bytesToBase64(priv.signaturePrivateKey),
    }),
  );
}

export function deserializePrivatePackage(data: string): PrivateKeyPackage {
  const parsed = JSON.parse(atob(data)) as {
    initPrivateKey: string;
    hpkePrivateKey: string;
    signaturePrivateKey: string;
  };

  return {
    initPrivateKey: base64ToBytes(parsed.initPrivateKey),
    hpkePrivateKey: base64ToBytes(parsed.hpkePrivateKey),
    signaturePrivateKey: base64ToBytes(parsed.signaturePrivateKey),
  };
}

export async function generateMemberKeyPackage(userId: string, impl: CiphersuiteImpl) {
  return generateKeyPackage(
    createBasicCredential(userId),
    defaultCapabilities(),
    defaultLifetime,
    [],
    impl,
  );
}

export function zeroOutPrivateKeyPackage(priv: PrivateKeyPackage): void {
  zeroOutUint8Array(priv.initPrivateKey);
  zeroOutUint8Array(priv.hpkePrivateKey);
  zeroOutUint8Array(priv.signaturePrivateKey);
}

export async function createKeyPackageRecord(
  userId: string,
  impl: CiphersuiteImpl,
): Promise<MlsKeyPackageRecord> {
  const kp = await generateMemberKeyPackage(userId, impl);
  const encodedPublic = encodeMlsMessage({
    keyPackage: kp.publicPackage,
    wireformat: 'mls_key_package',
    version: MlsProtocolVersions.current,
  });

  const record: MlsKeyPackageRecord = {
    userId,
    packageRef: crypto.randomUUID(),
    packageData: bytesToBase64(encodedPublic),
    privateData: serializePrivatePackage(kp.privatePackage),
    createdAt: new Date().toISOString(),
  };

  zeroOutPrivateKeyPackage(kp.privatePackage);
  return record;
}

export function getGroupMembers(state: ClientState): LeafNode[] {
  return state.ratchetTree.flatMap((node, nodeIndex) => {
    if (node === undefined || nodeIndex % 2 !== 0 || node.nodeType !== 'leaf') return [];
    return [node.leaf];
  });
}

export function getMemberUserIds(state: ClientState): string[] {
  return getGroupMembers(state).flatMap((leaf: LeafNode) => {
    if (leaf.credential.credentialType !== 'basic') return [];
    return [textDecoder.decode(leaf.credential.identity)];
  });
}

export function findLeafIndex(state: ClientState, targetUserId: string): LeafIndex | null {
  const tree = state.ratchetTree;
  for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex += 2) {
    const node = tree[nodeIndex];
    if (node === undefined || node.nodeType !== 'leaf') continue;
    if (node.leaf.credential.credentialType !== 'basic') continue;
    if (textDecoder.decode(node.leaf.credential.identity) === targetUserId) {
      return (nodeIndex / 2) as LeafIndex;
    }
  }
  return null;
}

export async function buildAddProposals(userIds: string[]): Promise<AddProposalBuildResult> {
  const results = await Promise.all(
    userIds.map(async (userId): Promise<{ proposal: Proposal | null; userId: string }> => {
      try {
        const kpData = await fetchUserKeyPackage(userId);
        if (!kpData) return { proposal: null, userId };

        const kpBytes = base64ToBytes(kpData.package_data);
        const decoded = decodeMlsMessage(kpBytes, 0);
        if (!decoded) return { proposal: null, userId };

        const [msg] = decoded;
        if (msg.wireformat !== 'mls_key_package') {
          return { proposal: null, userId };
        }

        return {
          proposal: { proposalType: 'add', add: { keyPackage: msg.keyPackage } },
          userId,
        };
      } catch {
        return { proposal: null, userId };
      }
    }),
  );

  const proposals: Proposal[] = [];
  const addedUserIds: string[] = [];
  const missingUserIds: string[] = [];

  results.forEach(({ proposal, userId }) => {
    if (proposal) {
      proposals.push(proposal);
      addedUserIds.push(userId);
      return;
    }

    missingUserIds.push(userId);
  });

  return {
    proposals,
    addedUserIds,
    missingUserIds,
  };
}
