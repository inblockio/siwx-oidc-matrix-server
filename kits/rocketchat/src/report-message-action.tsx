// Bundler swap of Rocket.Chat's useReportMessageAction that WRAPS it (0 source patches; patch reason class "D17 Element
// dialog"): the original decides who gets the item (not own messages, not livechat, a subscription) and its look; only the
// press changes. Instead of Rocket.Chat's ReportMessageModal (which posts `chat.reportMessage`, not answered) the press
// opens Element's own report dialog over the kit (bridge.openReport), which sends the report to the homeserver itself.
import type { IMessage, IRoom, ISubscription } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useReportMessageAction as useOriginalReportMessageAction } from 'rc/client/components/message/toolbar/useReportMessageAction.tsx?kit-original';

import { getSource } from './adapter/bridge.ts';

export const useReportMessageAction = (message: IMessage, context: { room: IRoom; subscription: ISubscription | undefined }) => {
	const original = useOriginalReportMessageAction(message, context);
	// A call card has no report row in the host (kitCanReport, see adapter/map.ts): no item, as for Pin and Copy link.
	if (!original || (message as IMessage & { kitCanReport?: boolean }).kitCanReport !== true) return null;
	return {
		...original,
		action() {
			getSource()
				.openReport(message._id)
				.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
		},
	};
};
