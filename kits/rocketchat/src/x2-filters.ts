// Pure filters for the D41 hides (no Rocket.Chat imports: the unit tests load this file). None of them mutates its input.

type Section = { title?: unknown; items: Array<{ id?: string }> };

/** View mode, avatars and grouping. Sort-by ids (`activity`, `name`) and any future id stay. */
export const DISPLAY_PREF_IDS = ['extended', 'medium', 'condensed', 'avatars', 'unread', 'favorites', 'types'] as const;

const isDisplayPref = (id: string | undefined): boolean => id !== undefined && (DISPLAY_PREF_IDS as readonly string[]).includes(id);

/** Drop the display-preference items from every section, then drop a section that has no items left. */
export const withoutDisplayPrefs = <S extends Section>(sections: readonly S[]): S[] =>
	sections
		.map((section) => ({ ...section, items: section.items.filter((item) => !isDisplayPref(item.id)) }))
		.filter((section) => section.items.length > 0);

/** Drop the room menu's Hide item (`hideRoom`), then drop a section that has no items left. */
export const withoutHideRoom = <S extends Section>(sections: readonly S[]): S[] =>
	sections
		.map((section) => ({ ...section, items: section.items.filter((item) => item.id !== 'hideRoom') }))
		.filter((section) => section.items.length > 0);

/**
 * Drop a section whose title is a non-empty string and whose items are empty (the user menu's "Status" once the presets
 * are gone). A non-string title (the header is a React element) or any items stays.
 */
export const withoutEmptyStatusSection = <S extends Section>(sections: readonly S[]): S[] =>
	sections.filter((section) => !(typeof section.title === 'string' && section.title.length > 0 && section.items.length === 0));

/**
 * Only a custom category has a group menu (Manage, Delete, Create new). The built-in groups (Favorites, Channels, Direct
 * messages) carry no category in the room list, or a default one; their menu would hold nothing but Move up / Move down
 * (N/A), so the kit renders none.
 */
export const hasCategoryMenu = (category: { default?: boolean } | undefined): boolean => category !== undefined && !category.default;

/**
 * M11 Y3: which of a custom category's Move up / Move down are enabled. `customIds` is the user's custom categories in the order the kit lists
 * them (Element's order); the first custom cannot move up, the last cannot move down, an unknown id or a host without category move moves nowhere.
 */
export const moveEdges = (customIds: readonly string[], id: string, available: boolean): { canMoveUp: boolean; canMoveDown: boolean } => {
	const i = customIds.indexOf(id);
	if (!available || i < 0) return { canMoveUp: false, canMoveDown: false };
	return { canMoveUp: i > 0, canMoveDown: i < customIds.length - 1 };
};
