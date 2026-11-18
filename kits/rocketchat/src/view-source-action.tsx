// Bundler swap of Rocket.Chat's useReadReceiptsDetailsAction (patch reason class "D31 dialog"): the kit has no read receipts
// detail (the row stays N/A), so its slot in the message "More" menu carries "View source" instead. The press opens Element's own
// View source dialog over the kit (bridge.openViewSource: the event id and the event JSON, decrypted and original for an encrypted
// event). The dialog is read-only, so the kit keeps no state; closing it changes nothing.
import type { IMessage } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';

import { getSource } from './adapter/bridge.ts';
import { VIEW_SOURCE_CONTEXTS } from './view-source-contexts.ts';

// The label is a plain sentence, not a key of Rocket.Chat's locale files: i18next shows a key it does not know as written.
export const useReadReceiptsDetailsAction = (message: IMessage) => ({
	id: 'view-source',
	icon: 'code',
	label: 'View source',
	context: VIEW_SOURCE_CONTEXTS,
	type: 'duplication',
	action() {
		getSource()
			.openViewSource(message._id)
			.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
	},
	order: 11,
	group: 'menu',
});
