// Bundler swap of Rocket.Chat's usePermalinkAction that WRAPS it (0 source patches; patch reason class "D17 Element
// permalink"): the original copies a Rocket.Chat room route (`/channel/<slug>?msg=<id>`), which means nothing outside this
// view. The adapter carries Element's own permalink of the event (`ViewMessage.permalink`, `RoomPermalinkCreator`: matrix.to
// or the configured prefix, with the `via` servers) as `kitPermalink`; the item copies that, with Rocket.Chat's own toast.
// A message without one (Rocket.Chat's optimistic copy before the event exists, a deleted message) gets no item. The
// Quote action keeps using Rocket.Chat's route link (`getPermaLink`, parsed back by `parseQuotes`): not touched here.
import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { useTranslation } from 'react-i18next';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { usePermalinkAction as useOriginalPermalinkAction } from 'rc/client/components/message/toolbar/usePermalinkAction.ts?kit-original';

type Config = Parameters<typeof useOriginalPermalinkAction>[1];

export const usePermalinkAction = (message: IMessage, config: Config, context: { room: IRoom }) => {
	const original = useOriginalPermalinkAction(message, config, context);
	const dispatchToastMessage = useToastMessageDispatch();
	const { t } = useTranslation();
	const link = (message as IMessage & { kitPermalink?: string }).kitPermalink;
	if (!original || typeof link !== 'string' || !link) return null;
	return {
		...original,
		// The Matrix link does not depend on the body: an undecryptable message (Rocket.Chat's "encrypted" lock) still has one.
		disabled: false,
		tooltip: undefined,
		async action() {
			try {
				await navigator.clipboard.writeText(link);
				dispatchToastMessage({ type: 'success', message: t('Copied') });
			} catch (e) {
				dispatchToastMessage({ type: 'error', message: e });
			}
		},
	};
};
