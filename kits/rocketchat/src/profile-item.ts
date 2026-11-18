// Pure mapper for the user menu's settings items (no Rocket.Chat imports: the unit tests load this file). It does not mutate its input.

type Item = { id?: string; onClick?: unknown; icon?: unknown; content?: unknown };
type Section = { items: Item[] };

/** The tabs of Element's settings dialog (the bridge's `ViewSettingsTab`, bridge version 5). */
export type SettingsTab = 'account' | 'preferences' | 'appearance' | 'labs';

/**
 * M11 Y2 (D43): the user menu item id -> the tab of Element's settings dialog it opens. Element has no accessibility tab: font
 * scaling and high contrast sit on Appearance. Rocket.Chat's own pages for these items are never opened (no route, no RC page).
 */
export const SETTINGS_TAB_BY_ITEM: Readonly<Record<string, SettingsTab>> = {
	profile: 'account',
	preferences: 'preferences',
	accessibility: 'appearance',
	'feature-preview': 'labs',
};

/**
 * What the host offers: `tabs` is a bridge version 5 host (Preferences and Accessibility reach their tab), `labs` is that and Element
 * lists a Labs tab (`ViewMe.settingsLabsTab`; Rocket.Chat's own `Accounts_AllowFeaturePreview` rule is not used, N2).
 */
export type TabsOffered = { tabs: boolean; labs: boolean };

/** Rocket.Chat 8.9.0's own Feature preview item (`useAccountItems.tsx`): id and icon; the label is its `Feature_preview` string, passed in by the caller (this file imports nothing). */
const FEATURE_PREVIEW = { id: 'feature-preview', icon: 'flask' } as const;
/** Where the inserted Feature preview item goes: right after the first of these that a section lists (Rocket.Chat's order is Profile, Preferences, Accessibility, Feature preview). */
const FEATURE_PREVIEW_AFTER = ['accessibility', 'preferences', 'profile'] as const;

/**
 * M10 W4: the "Profile" item (`profile`, in the Account section) runs `open('account')` instead of Rocket.Chat's own
 * `handleMyAccount` (a route to a settings page the kit does not render).
 * M11 Y2: on a host that offers the tabs (bridge version 5), Preferences and Accessibility run `open` on their tab. Below bridge version 5
 * those two and Feature preview are dropped (D38: no path to the page, hidden), and Profile keeps its M10 behaviour. Feature preview is
 * Element's Labs tab: where `offered.labs` it is inserted (Rocket.Chat lists it only when its `Accounts_AllowFeaturePreview` setting is on,
 * which the kit never sets, N2) in the Account section right after Accessibility and runs `open('labs')`; if Rocket.Chat lists it itself
 * the item is rewritten, never doubled; without a Labs tab it is dropped. Every other item and section is returned as it is.
 */
export const withProfileHandler = <S extends Section>(
	sections: readonly S[],
	open: (tab: SettingsTab) => void,
	offered: TabsOffered = { tabs: false, labs: false },
	featurePreviewLabel = 'Feature preview',
): S[] => {
	const mapped = sections.map((section) => ({
		...section,
		items: section.items.flatMap((item): Item[] => {
			const tab = item.id === undefined ? undefined : SETTINGS_TAB_BY_ITEM[item.id];
			if (!tab) return [item];
			if (tab === 'account') return [{ ...item, onClick: () => open(tab) }];
			if (!offered.tabs || (tab === 'labs' && !offered.labs)) return [];
			return [{ ...item, onClick: () => open(tab) }];
		}),
	}));
	if (!offered.tabs || !offered.labs || mapped.some((section) => section.items.some((item) => item.id === FEATURE_PREVIEW.id))) return mapped as S[];
	const item: Item = { ...FEATURE_PREVIEW, content: featurePreviewLabel, onClick: () => open('labs') };
	for (const anchor of FEATURE_PREVIEW_AFTER) {
		const at = mapped.findIndex((section) => section.items.some((other) => other.id === anchor));
		if (at < 0) continue;
		const index = mapped[at].items.findIndex((other) => other.id === anchor);
		mapped[at] = { ...mapped[at], items: [...mapped[at].items.slice(0, index + 1), item, ...mapped[at].items.slice(index + 1)] };
		break;
	}
	return mapped as S[];
};
