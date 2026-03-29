import { Router } from 'express';
import { registerMemberRotateAddRoutes } from './members/rotateAdd.js';
import { registerMemberRotateRemoveRoutes } from './members/rotateRemove.js';
import { registerLegacyMemberRoutes } from './members/legacy.js';
import { registerMemberRoleRoutes } from './members/roles.js';
import { registerMemberEmitUpdateRoute } from './members/emitUpdate.js';
import { registerConversationNicknameRoutes } from './members/conversationNickname.js';

const router = Router({ mergeParams: true });

registerMemberRotateAddRoutes(router);
registerMemberRotateRemoveRoutes(router);
registerLegacyMemberRoutes(router);
registerMemberRoleRoutes(router);
registerMemberEmitUpdateRoute(router);
registerConversationNicknameRoutes(router);

export default router;
