// Bundler swap of Rocket.Chat's useWebDAVMessageAction (patch reason class "D29 shared util"): the kit has no WebDAV (the
// `webdav-upload` id stays in hide-actions.ts), so its slot in the message "More" menu carries "Copy Markdown" instead. The press
// asks the host to put the message's Markdown on the clipboard (bridge.copyMarkdown: Element's own `eventToMarkdown` and
// `copyPlainTextToClipboard`, the registry patch's "Copy Markdown" action), in the call stack of the click. Only where Element
// offers it (`ViewMessage.canCopyMarkdown`, carried as `kitCanCopyMarkdown`): not for an image, a redacted or an undecrypted message.
// The copy changes nothing in the room, so the kit keeps no state.
import type { IMessage } from '@rocket.chat/core-typings';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { useTranslation } from 'react-i18next';

import { getSource } from './adapter/bridge.ts';

// Copy's own contexts: not a call card, not the starred / pinned lists.
const COPY_CONTEXTS = ['message', 'message-mobile', 'threads', 'federated'];

export const useWebDAVMessageAction = (message: IMessage) => {
	const dispatchToastMessage = useToastMessageDispatch();
	const { t } = useTranslation();
	if ((message as IMessage & { kitCanCopyMarkdown?: boolean }).kitCanCopyMarkdown !== true) return null;
	return {
		id: 'copy-markdown',
		icon: 'copy',
		// A plain sentence, not a key of Rocket.Chat's locale files: i18next shows a key it does not know as written.
		label: 'Copy Markdown',
		context: COPY_CONTEXTS,
		type: 'duplication',
		async action() {
			try {
				await getSource().copyMarkdown(message._id);
				dispatchToastMessage({ type: 'success', message: t('Copied') });
			} catch (e) {
				dispatchToastMessage({ type: 'error', message: e });
			}
		},
		order: 7,
		group: 'menu',
	};
};
