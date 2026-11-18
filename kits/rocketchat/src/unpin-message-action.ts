// Bundler swap of Rocket.Chat's useUnpinMessageAction that WRAPS it (0 source patches; patch reason class "N/A hook"): the
// Unpin item is offered only where Element offers Unpin (`PinningUtils.canUnpin`, carried as `kitCanPin`, see pin-message-action.ts).
import type { IMessage, IRoom, ISubscription } from '@rocket.chat/core-typings';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useUnpinMessageAction as useOriginalUnpinMessageAction } from 'rc/client/components/message/toolbar/useUnpinMessageAction.ts?kit-original';

export const useUnpinMessageAction = (message: IMessage, context: { room: IRoom; subscription: ISubscription | undefined }) => {
	const action = useOriginalUnpinMessageAction(message, context);
	return (message as IMessage & { kitCanPin?: boolean }).kitCanPin === true ? action : null;
};
