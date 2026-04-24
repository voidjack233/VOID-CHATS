WITH latest_dm_versions AS (
  SELECT
    c.id AS conversation_id,
    GREATEST(1, COALESCE(MAX(version_sources.key_version), 1)) AS latest_key_version
  FROM conversations c
  LEFT JOIN (
    SELECT conversation_id, key_version
    FROM mls_group_key_archive
    WHERE key_version IS NOT NULL
    UNION ALL
    SELECT conversation_id, key_version
    FROM mls_group_states
    WHERE key_version IS NOT NULL
    UNION ALL
    SELECT conversation_id, key_version
    FROM mls_welcome_messages
    WHERE key_version IS NOT NULL
  ) AS version_sources
    ON version_sources.conversation_id = c.id
  WHERE c.type = 'dm'
  GROUP BY c.id
)
UPDATE conversations c
SET current_key_version = latest_dm_versions.latest_key_version
FROM latest_dm_versions
WHERE c.id = latest_dm_versions.conversation_id
  AND COALESCE(c.current_key_version, 0) < latest_dm_versions.latest_key_version;
