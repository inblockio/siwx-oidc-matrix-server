// Bundler swap of Rocket.Chat's EmojiPickerProvider that WRAPS it (0 source patches; patch reason class "D17 Element picker"):
// Rocket.Chat remembers an emoji for the toolbar's quick reactions only when its own toolbar button or picker is used
// (`addRecentEmoji`). A reaction sent through Element's picker or a chip press never reaches it, so a child of the provider
// listens for the user's new reactions (Source.onOwnReaction) and records each one the same way.
import { type ReactNode } from 'react';
import { useEmojiPickerData } from 'rc/client/contexts/EmojiPickerContext';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import EmojiPickerProvider from 'rc/client/providers/EmojiPickerProvider/EmojiPickerProvider.tsx?kit-original';

import { getSource } from './adapter/bridge.ts';
import { useRecentEmojiQueue } from './recent-emoji-queue.ts';

const subscribe = (cb: (name: string) => void) => getSource().onOwnReaction(cb);

const RecentEmojiRecorder = () => {
	const { addRecentEmoji } = useEmojiPickerData();
	useRecentEmojiQueue(addRecentEmoji, subscribe);
	return null;
};

const WithRecorder = ({ children }: { children: ReactNode }) => (
	<EmojiPickerProvider>
		<RecentEmojiRecorder />
		{children}
	</EmojiPickerProvider>
);

export default WithRecorder;
