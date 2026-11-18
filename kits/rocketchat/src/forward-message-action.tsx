// Bundler swap of Rocket.Chat's hover-toolbar ForwardMessageAction (patch reason class "D31 dialog"): Forward opens Element's
// own forward dialog over the kit (bridge.openForward) instead of Rocket.Chat's ForwardMessageModal, which stays unused.
// The dialog sends each copy and shows its result itself, so the kit keeps no state. A jump through the dialog's room name
// ends the action in that room (outcome.roomId differs from the message's room): the kit opens it in its own router.
import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';
import MessageToolbarItem from 'rc/client/components/message/toolbar/MessageToolbarItem';
import { useTranslation } from 'react-i18next';

import { getSource } from './adapter/bridge.ts';
import { forwardFailure } from './adapter/source.ts';
import { openRoom } from './room-opener.ts';

export type ForwardMessageActionProps = {
	message: IMessage;
	room: IRoom;
};

const forward = async (message: IMessage): Promise<void> => {
	const source = getSource();
	const outcome = await source.openForward(message._id);
	if (outcome.status !== 'done' || !outcome.roomId || outcome.roomId === message.rid) return;
	if (await source.roomShown(outcome.roomId)) openRoom(outcome.roomId);
};

const ForwardMessageAction = ({ message }: ForwardMessageActionProps) => {
	const { t } = useTranslation();
	return (
		<MessageToolbarItem
			id='forward-message'
			icon='arrow-forward'
			title={t('Forward_message')}
			onClick={() => {
				forward(message).catch((error: unknown) => dispatchToastMessage({ type: 'error', message: forwardFailure(error) }));
			}}
		/>
	);
};

export default ForwardMessageAction;
