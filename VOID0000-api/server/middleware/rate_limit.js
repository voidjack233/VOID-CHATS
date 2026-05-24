// middleware/rate_limit.js
//
// Public exports stay here so existing route imports do not need to know about
// the internal rate-limit layout.

import { RATE_LIMIT_POLICIES } from './rateLimits/policies.js';
import { createConfiguredLimiter } from './rateLimits/createLimiter.js';

export { dmSpamGuard } from './rateLimits/dmSpamGuard.js';

export const authDeviceLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.authDevice);
export const forgotPasswordLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.forgotPassword);
export const resetDeviceLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.resetDevice);
export const checkResetTokenLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.checkResetToken);
export const registerDeviceLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.registerDevice);
export const authCheckLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.authCheck);
export const refreshTokenLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.refreshToken);
export const profileUpdateLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.profileUpdate);
export const avatarUploadLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.avatarUpload);
export const captchaGenerateLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.captchaGenerate);
export const captchaCheckLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.captchaCheck);
export const friendsListLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.friendsList);
export const friendsPresenceLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.friendsPresence);
export const friendsRequestsLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.friendsRequests);
export const friendActionLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.friendAction);
export const messagesFetchLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.messagesFetch);
export const messagesSendLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.messagesSend);
export const messageReactionToggleLimiter = createConfiguredLimiter(
  RATE_LIMIT_POLICIES.messageReactionToggle,
);
export const linkPreviewLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.linkPreview);
export const mlsSyncLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.mlsSync);
export const mlsKeyPackageCheckLimiter = createConfiguredLimiter(
  RATE_LIMIT_POLICIES.mlsKeyPackageCheck,
);
export const mlsKeyPackagePublishLimiter = createConfiguredLimiter(
  RATE_LIMIT_POLICIES.mlsKeyPackagePublish,
);
export const mlsGroupKeyArchiveLimiter = createConfiguredLimiter(
  RATE_LIMIT_POLICIES.mlsGroupKeyArchive,
);
export const userSearchLimiter = createConfiguredLimiter(RATE_LIMIT_POLICIES.userSearch);
