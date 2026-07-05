import { Router } from 'express';
import { registerMemberRotateAddRoutes } from './members/rotateAdd.js';
import { registerMemberRotateRemoveRoutes } from './members/rotateRemove.js';
import { registerMemberLeaveRoutes } from './members/leave.js';
import { registerMemberSelfLeaveRoutes } from './members/selfLeave.js';
import { registerLegacyMemberRoutes } from './members/legacy.js';
import { registerMemberOwnershipRoutes } from './members/ownership.js';
import { registerMemberRoleRoutes } from './members/roles.js';
import { registerMemberEmitUpdateRoute } from './members/emitUpdate.js';
import { registerConversationNicknameRoutes } from './members/conversationNickname.js';

const router = Router({ mergeParams: true });

registerMemberRotateAddRoutes(router);
registerMemberRotateRemoveRoutes(router);
registerMemberLeaveRoutes(router);
registerMemberSelfLeaveRoutes(router);
registerLegacyMemberRoutes(router);
registerMemberOwnershipRoutes(router);
registerMemberRoleRoutes(router);
registerMemberEmitUpdateRoute(router);
registerConversationNicknameRoutes(router);

export default router;
