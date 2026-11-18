// Bundler swap of Rocket.Chat's side-panel room menu (patch class "D41 hide"): Hide has no Element equivalent, so the
// `hideRoom` item is removed. The side-panel hook takes an extra `href`; its params are passed through.
import type { useRoomMenuActions as UseRocketChatRoomMenuActions } from 'rc/client/views/navigation/sidepanel/hooks/useRoomMenuActions.ts?kit-original';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useRoomMenuActions as useRocketChatRoomMenuActions } from 'rc/client/views/navigation/sidepanel/hooks/useRoomMenuActions.ts?kit-original';

import { withoutHideRoom } from './x2-filters.ts';

export const useRoomMenuActions: typeof UseRocketChatRoomMenuActions = (params) => withoutHideRoom(useRocketChatRoomMenuActions(params));
