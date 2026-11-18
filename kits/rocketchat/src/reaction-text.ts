// A Matrix reaction key Rocket.Chat's emoji data has no name for (text such as "lol", or an emoji newer than the data)
// rendered as an empty chip: Rocket.Chat draws a reaction through its emoji registry, and an unknown name renders
// nothing (kit inc2 F2). Such a key is registered as its own emoji, in a kit package whose render is the key as text,
// through the same registry Rocket.Chat's emoji packages use. The key is any room member's text, so it is escaped.

type Registry = { packages: Record<string, unknown>; list: Record<string, unknown> };

const PACKAGE = 'element-reaction';

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const textEmojiHtml = (key: string): string =>
	`<span class="emoji" data-title="${escape(key)}" name="${escape(key)}">${escape(key)}</span>`;

export const registerTextReaction = (registry: Registry, key: string): void => {
	registry.packages[PACKAGE] ??= {
		emojiCategories: [],
		categoryIndex: 0,
		emojisByCategory: {},
		toneList: {},
		render: textEmojiHtml,
		renderPicker: () => undefined,
	};
	registry.list[key] ??= { emojiPackage: PACKAGE };
};
