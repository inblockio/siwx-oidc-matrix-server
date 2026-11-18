// Bundler swap of Rocket.Chat's useEditMessageAction that WRAPS it (0 source patches; patch reason class "N/A hook"):
// the original offers "Edit" on every message of the user; Element lets the user edit only what its own rule allows
// (`canEditContent`: sent, not deleted, not an edit, text or emote). The adapter carries that verdict as `kitCanEdit`
// (ViewMessage.canEdit); a message without it gets no Edit item.
import type { IMessage, IRoom, ISubscription } from '@rocket.chat/core-typings';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useEditMessageAction as useOriginalEditMessageAction } from 'rc/client/components/message/toolbar/useEditMessageAction.ts?kit-original';

export const useEditMessageAction = (message: IMessage, context: { room: IRoom; subscription: ISubscription | undefined }) => {
	const action = useOriginalEditMessageAction(message, context);
	return (message as IMessage & { kitCanEdit?: boolean }).kitCanEdit === true ? action : null;
};
