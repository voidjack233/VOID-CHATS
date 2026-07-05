ALTER TABLE conversation_membership_rotations
  DROP CONSTRAINT IF EXISTS conversation_membership_rotations_kind_check;

ALTER TABLE conversation_membership_rotations
  ADD CONSTRAINT conversation_membership_rotations_kind_check
  CHECK (kind IN ('direct_add', 'invite_approval', 'remove', 'self_leave'));
