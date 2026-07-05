import {
  MAX_EVENT_REF_LENGTH,
  MAX_GROUP_ID_LENGTH,
  MAX_MESSAGE_PAYLOAD_LENGTH,
  MAX_STATE_BLOB_LENGTH,
  normalizeRequiredString,
  parsePositiveInt,
} from './shared.js';

function invalidArtifacts(error) {
  return {
    error,
    code: 'MLS_ARTIFACTS_INVALID',
  };
}

function artifactReferenceConflict() {
  return Object.assign(new Error('MLS artifact reference already exists; retry the membership change'), {
    status: 409,
    code: 'MLS_ARTIFACT_REF_CONFLICT',
  });
}

export function resolveMembershipRepairWelcomeUserIds(rawArtifacts, allowedUserIds) {
  const allowedUsers = new Set(allowedUserIds.map((value) => String(value)));
  const rawWelcomes = Array.isArray(rawArtifacts?.welcomes) ? rawArtifacts.welcomes : [];
  const welcomeUserIds = rawWelcomes.map((welcome) => (
    String(welcome?.user_id ?? welcome?.userId ?? '').trim()
  ));

  if (welcomeUserIds.some((userId) => !userId || !allowedUsers.has(userId))) {
    return invalidArtifacts('Self-leave repair Welcomes may only target active remaining members');
  }

  return { welcomeUserIds };
}

function parseOptionalKeyVersion(value, pendingKeyVersion) {
  if (value == null) return true;
  return parsePositiveInt(value, -1) === pendingKeyVersion;
}

export function parseMembershipFinalizeArtifacts(
  rawArtifacts,
  {
    expectedWelcomeUserIds = [],
    pendingKeyVersion,
    requireCommit = false,
  },
) {
  if (!rawArtifacts || typeof rawArtifacts !== 'object') {
    return {
      error: 'MLS finalize artifacts are required',
      code: 'MLS_ARTIFACTS_REQUIRED',
    };
  }

  const rawSnapshot = rawArtifacts.snapshot;
  const groupId = normalizeRequiredString(
    rawSnapshot?.group_id ?? rawSnapshot?.groupId,
    MAX_GROUP_ID_LENGTH,
  );
  const stateBlob = normalizeRequiredString(
    rawSnapshot?.state_blob ?? rawSnapshot?.stateBlob,
    MAX_STATE_BLOB_LENGTH,
  );
  const epoch = parsePositiveInt(rawSnapshot?.epoch, -1);
  const snapshotKeyVersion = rawSnapshot?.key_version ?? rawSnapshot?.keyVersion;

  if (!groupId || !stateBlob || epoch <= 0) {
    return invalidArtifacts('A snapshot with group_id, state_blob, and positive epoch is required');
  }

  if (!parseOptionalKeyVersion(snapshotKeyVersion, pendingKeyVersion)) {
    return invalidArtifacts('Snapshot key_version does not match the pending rotation');
  }

  const expectedUsers = [...new Set(expectedWelcomeUserIds.map((value) => String(value)))];
  const rawWelcomes = Array.isArray(rawArtifacts.welcomes) ? rawArtifacts.welcomes : [];
  if (rawWelcomes.length !== expectedUsers.length) {
    return invalidArtifacts('Secure join approval could not be prepared. Ask the requester to refresh VOID, then retry approval.');
  }

  const welcomes = [];
  const seenWelcomeUsers = new Set();
  for (const rawWelcome of rawWelcomes) {
    const userId = String(rawWelcome?.user_id ?? rawWelcome?.userId ?? '').trim();
    const welcomeRef = normalizeRequiredString(
      rawWelcome?.welcome_ref ?? rawWelcome?.welcomeRef,
      MAX_EVENT_REF_LENGTH,
    );
    const payload = normalizeRequiredString(rawWelcome?.payload, MAX_MESSAGE_PAYLOAD_LENGTH);
    const keyVersion = rawWelcome?.key_version ?? rawWelcome?.keyVersion;

    if (!expectedUsers.includes(userId) || seenWelcomeUsers.has(userId) || !welcomeRef || !payload) {
      return invalidArtifacts('Welcome payload recipients must exactly match the pending joining members');
    }

    if (!parseOptionalKeyVersion(keyVersion, pendingKeyVersion)) {
      return invalidArtifacts('Welcome key_version does not match the pending rotation');
    }

    seenWelcomeUsers.add(userId);
    welcomes.push({ userId, welcomeRef, payload });
  }

  const rawCommit = rawArtifacts.commit;
  let commit = null;
  if (rawCommit != null) {
    const commitRef = normalizeRequiredString(
      rawCommit?.commit_ref ?? rawCommit?.commitRef,
      MAX_EVENT_REF_LENGTH,
    );
    const payload = normalizeRequiredString(rawCommit?.payload, MAX_MESSAGE_PAYLOAD_LENGTH);
    const commitEpoch = parsePositiveInt(rawCommit?.epoch, -1);

    if (!commitRef || !payload || commitEpoch < pendingKeyVersion - 1) {
      return invalidArtifacts('Commit payload is invalid for the pending rotation');
    }

    commit = { commitRef, payload, epoch: commitEpoch };
  }

  if (requireCommit && !commit) {
    return invalidArtifacts('An MLS commit is required for existing members');
  }

  if (!requireCommit && commit) {
    return invalidArtifacts('An MLS commit was provided when no existing peer requires it');
  }

  return {
    artifacts: {
      snapshot: { groupId, stateBlob, epoch },
      welcomes,
      commit,
    },
  };
}

export async function insertMembershipFinalizeArtifacts(
  client,
  {
    conversationId,
    actorUserId,
    pendingKeyVersion,
    artifacts,
  },
) {
  const { snapshot, welcomes, commit } = artifacts;

  await client.query(
    `INSERT INTO mls_group_states (
       conversation_id,
       user_id,
       group_id,
       epoch,
       key_version,
       state_blob,
       created_at,
       updated_at
     )
     VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET
       group_id = EXCLUDED.group_id,
       epoch = EXCLUDED.epoch,
       key_version = EXCLUDED.key_version,
       state_blob = EXCLUDED.state_blob,
       updated_at = NOW()`,
    [conversationId, actorUserId, snapshot.groupId, snapshot.epoch, pendingKeyVersion, snapshot.stateBlob],
  );

  await client.query(
    `INSERT INTO mls_group_state_history (
       conversation_id,
       user_id,
       group_id,
       epoch,
       key_version,
       state_blob,
       created_at,
       updated_at
     )
     VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (conversation_id, user_id, key_version)
     DO UPDATE SET
       group_id = EXCLUDED.group_id,
       epoch = EXCLUDED.epoch,
       state_blob = EXCLUDED.state_blob,
       updated_at = NOW()`,
    [conversationId, actorUserId, snapshot.groupId, snapshot.epoch, pendingKeyVersion, snapshot.stateBlob],
  );

  for (const welcome of welcomes) {
    const insertWelcomeResult = await client.query(
      `INSERT INTO mls_welcome_messages (
         user_id,
         welcome_ref,
         conversation_id,
         payload,
         key_version,
         received_at,
         consumed_at
       )
       VALUES ($1::UUID, $2, $3::UUID, $4, $5, NOW(), NULL)
       ON CONFLICT (user_id, welcome_ref)
       DO NOTHING
       RETURNING welcome_ref`,
      [welcome.userId, welcome.welcomeRef, conversationId, welcome.payload, pendingKeyVersion],
    );

    if (insertWelcomeResult.rows.length === 0) {
      throw artifactReferenceConflict();
    }
  }

  if (commit) {
    const insertCommitResult = await client.query(
      `INSERT INTO mls_commit_messages (
         conversation_id,
         commit_ref,
         payload,
         epoch,
         received_at,
         applied_at
       )
       VALUES ($1::UUID, $2, $3, $4, NOW(), NULL)
       ON CONFLICT (conversation_id, commit_ref)
       DO NOTHING
       RETURNING commit_ref`,
      [conversationId, commit.commitRef, commit.payload, commit.epoch],
    );

    if (insertCommitResult.rows.length === 0) {
      throw artifactReferenceConflict();
    }
  }
}
