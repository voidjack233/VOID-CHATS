-- Roll back the experimental attachment archive/index.
-- This feature duplicated encrypted attachment metadata onto the backend and
-- should not ship in a privacy-first build.

DROP TABLE IF EXISTS conversation_attachments;
