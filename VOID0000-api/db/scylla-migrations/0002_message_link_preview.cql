ALTER TABLE {{KEYSPACE}}.messages ADD encrypted_link_preview text;
ALTER TABLE {{KEYSPACE}}.messages ADD link_preview_iv text;
ALTER TABLE {{KEYSPACE}}.messages ADD link_preview_key_version int;
