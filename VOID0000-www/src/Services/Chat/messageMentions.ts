import type { ConversationMember, MessageMentionMetadata } from './chatTypes';

export const MESSAGE_MENTION_PATTERN = /@([A-Za-z0-9._-]{1,32})/g;

function isMentionBoundary(text: string, start: number): boolean {
  const previousChar = start > 0 ? text[start - 1] : '';
  return !previousChar || !/[A-Za-z0-9._-]/.test(previousChar);
}

export function resolveMessageMentions(
  text: string,
  members: Array<Pick<ConversationMember, 'user_id' | 'username'>> = [],
): MessageMentionMetadata[] {
  if (!text || members.length === 0) {
    return [];
  }

  const membersByUsername = new Map(
    members
      .filter((member) => member.user_id && member.username)
      .map((member) => [member.username.toLowerCase(), member]),
  );

  const mentions = new Map<string, MessageMentionMetadata>();

  for (const match of text.matchAll(MESSAGE_MENTION_PATTERN)) {
    const username = match[1];
    const start = match.index ?? -1;
    if (!username || start < 0 || !isMentionBoundary(text, start)) {
      continue;
    }

    const member = membersByUsername.get(username.toLowerCase());
    if (!member) {
      continue;
    }

    mentions.set(member.user_id, {
      user_id: member.user_id,
      username: member.username,
    });
  }

  return Array.from(mentions.values());
}

export function getMentionUsernames(
  mentions?: MessageMentionMetadata[] | null,
): string[] {
  if (!mentions || mentions.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      mentions
        .map((mention) => mention.username?.trim())
        .filter((username): username is string => Boolean(username)),
    ),
  );
}
