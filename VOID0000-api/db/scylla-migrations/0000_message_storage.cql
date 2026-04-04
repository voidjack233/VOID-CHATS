CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.messages (
  conversation_id uuid,
  message_id timeuuid,
  sender_id uuid,
  encrypted_content text,
  iv text,
  key_version int,
  message_type text,
  reply_to timeuuid,
  attachments list<text>,
  is_edited boolean,
  edited_at timestamp,
  is_deleted boolean,
  created_at timestamp,
  PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.message_edits (
  conversation_id uuid,
  message_id timeuuid,
  edit_id timeuuid,
  encrypted_content text,
  iv text,
  key_version int,
  edited_at timestamp,
  PRIMARY KEY ((conversation_id, message_id), edit_id)
) WITH CLUSTERING ORDER BY (edit_id DESC);

CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.message_reactions (
  conversation_id uuid,
  message_id timeuuid,
  emoji text,
  user_id uuid,
  created_at timestamp,
  PRIMARY KEY ((conversation_id, message_id, emoji), user_id)
);

CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.user_reactions (
  conversation_id uuid,
  user_id uuid,
  message_id timeuuid,
  emoji text,
  PRIMARY KEY ((conversation_id, user_id), message_id, emoji)
);

CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.reaction_counts (
  conversation_id uuid,
  message_id timeuuid,
  emoji text,
  count counter,
  PRIMARY KEY ((conversation_id), message_id, emoji)
);
