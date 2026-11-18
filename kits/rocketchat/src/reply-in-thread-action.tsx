// Bundler swap of Rocket.Chat's hover-toolbar ReplyInThreadMessageAction (patch reason class "D37 thread panel"): "Reply in thread"
// opens Element's own thread panel over the kit (bridge.openThread) instead of Rocket.Chat's thread tab route. The button shows
// although `Threads_enabled` stays false (so no other Rocket.Chat thread UI appears). The panel's own composer sends the thread
// replies as Element does (`m.relates_to` `m.thread`), so the kit keeps no state; its reply count follows the timeline.
import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';
import MessageToolbarItem from 'rc/client/components/message/toolbar/MessageToolbarItem';
import { useTranslation } from 'react-i18next';

import { getSource } from './adapter/bridge.ts';
import { threadFailure } from './adapter/source.ts';

export type ReplyInThreadMessageActionProps = {
	message: IMessage;
	room: IRoom;
};

const ReplyInThreadMessageAction = ({ message }: ReplyInThreadMessageActionProps) => {
	const { t } = useTranslation();
	return (
		<MessageToolbarItem
			id='reply-in-thread'
			icon='thread'
			title={t('Reply_in_thread')}
			onClick={(event) => {
				event.stopPropagation();
				getSource()
					.openThread(message._id)
					.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: threadFailure(error) }));
			}}
		/>
	);
};

export default ReplyInThreadMessageAction;
