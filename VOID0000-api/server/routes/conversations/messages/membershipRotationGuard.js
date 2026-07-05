export async function hasPendingMembershipRotation(database, conversationId) {
  const result = await database.query(
    `SELECT operation_id
     FROM conversation_membership_rotations
     WHERE conversation_id = $1
       AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [conversationId],
  );

  return result.rows.length > 0;
}
