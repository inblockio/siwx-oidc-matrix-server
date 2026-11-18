// Bundler swap of Rocket.Chat's MessageListProvider that WRAPS it (0 source patches; patch reason class "D17 Element
// picker"): the "+" of a message's reactions row (`useOpenEmojiPicker`) opens Element's own reaction picker over the kit
// instead of Rocket.Chat's emoji picker. Everything else of the context is the original's.
import type { IMessage } from '@rocket.chat/core-typings';
import { memo, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { MessageListContext } from 'rc/client/components/message/list/MessageListContext';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import MessageListProvider from 'rc/client/views/room/MessageList/providers/MessageListProvider.tsx?kit-original';

import { openElementReactionPicker } from './element-reaction-picker.ts';

export type MessageListProviderProps = {
	children: ReactNode;
	attachmentDimension?: { width?: number; height?: number };
};

const ElementPicker = ({ children }: { children: ReactNode }) => {
	const context = useContext(MessageListContext);
	const value = useMemo(
		() => ({
			...context,
			useOpenEmojiPicker: (message: IMessage) => (e: MouseEvent<HTMLElement>) => {
				e.nativeEvent.stopImmediatePropagation();
				openElementReactionPicker(message, e.currentTarget);
			},
		}),
		[context],
	);
	return <MessageListContext.Provider value={value}>{children}</MessageListContext.Provider>;
};

const WithElementPicker = (props: MessageListProviderProps) => (
	<MessageListProvider {...props}>
		<ElementPicker>{props.children}</ElementPicker>
	</MessageListProvider>
);

export default memo(WithElementPicker);
