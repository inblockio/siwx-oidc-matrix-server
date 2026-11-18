// Bundler swap of Rocket.Chat's useReplyInDMAction that WRAPS it (0 source patches; patch reason class "D41 wire"): the original
// decides who gets the item (a subscription, not a direct room) and its look (label, icon, menu group); the kit hides it for your own
// message (N6) and on a host without `startDm`, and only the press changes. Instead of Rocket.Chat's /direct route with `reply=` the
// press opens (or starts) the direct chat with the sender through the bridge (bridge.startDm) and opens that room. No quote: a message
// quoted into another room has no Matrix form (docs/track/m5/WHAT-WORKS.md, M11).
import type { IMessage, IRoom, ISubscription } from '@rocket.chat/core-typings';
import { useUser } from '@rocket.chat/ui-contexts';
import { dispatchToastMessage } from 'rc/client/lib/toast';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useReplyInDMAction as useOriginalReplyInDMAction } from 'rc/client/components/message/toolbar/useReplyInDMAction.ts?kit-original';

import { getSource } from './adapter/bridge.ts';
import { replyDirectlyShown, runReplyDirectly } from './reply-directly-flow.ts';
import { openRoom } from './room-opener.ts';

export const useReplyInDMAction = (message: IMessage, context: { room: IRoom; subscription: ISubscription | undefined }) => {
	const original = useOriginalReplyInDMAction(message, context);
	const user = useUser();
	if (!original || !replyDirectlyShown({ original: true, canStartDm: getSource().canStartDm(), senderId: message.u._id, ownId: user?._id })) return null;
	return {
		...original,
		action() {
			void runReplyDirectly(
				{
					startDm: (id, fromRoomId) => getSource().startDm(id, fromRoomId),
					openRoom: (rid) => openRoom(rid),
					fail: (error) => dispatchToastMessage({ type: 'error', message: error }),
				},
				message.u.username as string,
				// M12 Z2 F1: the room of this message (the Matrix room id), so the host titles a new chat from the person on it.
				message.rid,
			);
		},
	};
};
