// Bundler swap of Rocket.Chat's hover-toolbar ReactionMessageAction that WRAPS it (0 source patches; patch reason class
// "D17 Element picker"): the quick reactions are the original's (they post `/v1/chat.react`, which the adapter answers);
// its "Add reaction" button opens Element's own reaction picker over the kit instead of Rocket.Chat's emoji picker. The
// original asks `chat.emojiPicker.open(button, callback)`, so inside this subtree `open` is Element's picker. Call cards, the
// encryption line and pending-key messages get no reaction control at all (D38: Element has none there).
import { useMemo } from 'react';
import { ChatContext, useChat } from 'rc/client/views/room/contexts/ChatContext';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import ReactionMessageAction, {
	type ReactionMessageActionProps,
} from 'rc/client/components/message/toolbar/items/actions/ReactionMessageAction.tsx?kit-original';

import { isNoMessageEvent } from './adapter/map.ts';
import { openElementReactionPicker } from './element-reaction-picker.ts';

const WithElementPicker = (props: ReactionMessageActionProps) => {
	const chat = useChat();
	const { message } = props;
	const patched = useMemo(
		() =>
			chat &&
			new Proxy(chat, {
				get: (target, prop) =>
					prop === 'emojiPicker'
						? { ...target.emojiPicker, open: (anchor: Element) => openElementReactionPicker(message, anchor) }
						: Reflect.get(target, prop, target),
			}),
		[chat, message],
	);
	return (
		<ChatContext.Provider value={patched}>
			<ReactionMessageAction {...props} />
		</ChatContext.Provider>
	);
};

// Element shows no react control on a call tile, the encryption line or a message still waiting for its key (they are no
// `m.room.message`), so there is none here: a toolbar click there would be byte-identical to the composer's `+:name:`.
const ReactionAction = (props: ReactionMessageActionProps) => (isNoMessageEvent(props.message) ? null : <WithElementPicker {...props} />);

export default ReactionAction;
