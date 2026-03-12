export function messageEventId(messageId) {
  return messageId ? `message:${messageId}` : null;
}

export function reactionEventId({
  conversationId,
  messageId,
  emoji,
  userId,
  action,
}) {
  if (!conversationId || !messageId || !emoji || !userId || !action) {
    return null;
  }

  return `reaction:${action}:${conversationId}:${messageId}:${emoji}:${userId}`;
}

export function friendshipEventId(type, friendshipId) {
  if (!type || !friendshipId) {
    return null;
  }

  return `friendship:${type}:${friendshipId}`;
}
