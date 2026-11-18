// Bundler swap of Rocket.Chat's "Create new" items (patch reason class "D17 single confirmation"): Channel and Direct
// message open Element's own create-room and start-chat dialogs (the host's view-model actions) instead of Rocket.Chat's
// modals; the original's other items (team) are kept; Discussion is removed (D39) as they are. Element's dialog is the one confirmation;
// when it creates the room (or the chat), the room opens here.
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import type { UseCreateNewItemsParams } from 'rc/client/navbar/NavBarPagesGroup/hooks/useCreateNewItems.ts?kit-original';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useCreateNewItems as useRocketChatCreateNewItems } from 'rc/client/navbar/NavBarPagesGroup/hooks/useCreateNewItems.ts?kit-original';

import { getSource } from './adapter/bridge.ts';
import { openRoom } from './room-opener.ts';

export const useCreateNewItems = (params: UseCreateNewItemsParams = {}): GenericMenuItemProps[] => {
	const dispatchToastMessage = useToastMessageDispatch();
	const run = (start: () => ReturnType<ReturnType<typeof getSource>['createRoom']>) => async () => {
		try {
			const outcome = await start();
			if (outcome.status === 'done' && outcome.roomId) openRoom(outcome.roomId);
		} catch (error) {
			dispatchToastMessage({ type: 'error', message: error });
		}
	};
	// Discussion has no Element equivalent (D39): the item is removed (Rocket.Chat shows it only with `Discussion_enabled`, which the adapter sets false; this keeps it gone if that setting is ever turned on).
	return useRocketChatCreateNewItems(params).filter((item) => item.id !== 'discussion').map((item) => {
		if (item.id === 'channel') return { ...item, onClick: run(() => getSource().createRoom()) };
		if (item.id === 'direct') return { ...item, onClick: run(() => getSource().createChat()) };
		return item;
	});
};
