// Bundler swap of Rocket.Chat's usePinMessageAction that WRAPS it (0 source patches; patch reason class "N/A hook"):
// the original offers "Pin" on every message the permission allows; Element offers pinning only where its own rule says so
// (`PinningUtils.canPin`: the user may send `m.room.pinned_events`, the event is a pinnable type, sent and not deleted). The
// adapter carries that verdict as `kitCanPin` (ViewMessage.canPin); a message without it gets no Pin item.
import type { IMessage, IRoom, ISubscription } from '@rocket.chat/core-typings';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { usePinMessageAction as useOriginalPinMessageAction } from 'rc/client/components/message/toolbar/usePinMessageAction.tsx?kit-original';

export const usePinMessageAction = (message: IMessage, context: { room: IRoom; subscription: ISubscription | undefined }) => {
	const action = useOriginalPinMessageAction(message, context);
	return (message as IMessage & { kitCanPin?: boolean }).kitCanPin === true ? action : null;
};
