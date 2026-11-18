// Matrix reaction keys are emoji; Rocket.Chat keys reactions by emoji name (":thumbsup:"). The lookup is Rocket.Chat's
// own emoji data (the native emoji package its message list renders with), so every name it gives renders there.
import { getEmojiData } from 'rc/app/emoji-native/lib/generateEmojiData';

import { emoji } from 'rc/client/lib/emoji/lib';

import { setReactionName, setReactionUnicode } from './adapter/map.ts';
import { registerTextReaction } from './reaction-text.ts';

let byEmoji: Map<string, string> | undefined;

const lookup = (key: string): string => {
	if (!byEmoji) {
		byEmoji = new Map();
		for (const [name, entry] of Object.entries(getEmojiData().emojiList)) {
			for (const u of entry.unicode ? [entry.unicode, entry.unicode.replace(/\uFE0F/g, '')] : []) {
				if (!byEmoji.has(u)) byEmoji.set(u, name);
			}
		}
	}
	// Element may send an emoji with or without the variation selector (U+FE0F).
	const name = byEmoji.get(key) ?? byEmoji.get(key.replace(/️/g, ''));
	if (name) return name;
	// No Rocket.Chat name: the key renders as its own text (reaction-text.ts, kit inc2 F2).
	registerTextReaction(emoji, key);
	return key;
};

setReactionName(lookup);

// The other way, for `/v1/chat.react`: a `:shortname:` (primary or alternate) back to its emoji.
setReactionUnicode((name) => getEmojiData().emojiList[name]?.unicode);
