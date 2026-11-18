// "Add reaction" opens Element's own reaction picker (D17, patch reason class "D17 Element picker"): the host renders
// Element's ContextMenu + ReactionPicker over the kit (bridge.openReactionPicker); a chosen reaction comes back as a change
// of the message's reactions, so there is no callback to run. Rocket.Chat's emoji picker stays for the composer.
import type { IMessage } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';

import { getSource } from './adapter/bridge.ts';

export const openElementReactionPicker = (message: Pick<IMessage, '_id'>, anchor: Element): void => {
	const { x, y, width, height } = anchor.getBoundingClientRect();
	getSource()
		.openReactionPicker(message._id, { x, y, width, height })
		.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
};
