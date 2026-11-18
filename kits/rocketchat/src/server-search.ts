// M10 W5 (patch reason class "D41 wire"): the sidebar search hands its term to Element's own Spotlight (bridge.openDirectory,
// filter rooms or people). No Rocket.Chat imports, so the rules are unit-tested; navbar-search-listbox.tsx renders them.
// Never a search call or index of ours (D1, D38): the kit only passes the typed term on.
import type { DirectoryOptions } from './directory-flow.ts';

export type ServerSearchOption = { filter: 'rooms' | 'people'; term: string; label: string };

/** The term to search for: the typed text without Rocket.Chat's `@` / `#` prefix (it only narrows the local rows), trimmed. */
export const serverSearchTerm = (filterText = ''): string => filterText.trim().replace(/^[@#]/, '').trim();

/**
 * The two hand-off options "Public rooms matching <term>" and "People matching <term>" for a typed text, in this order.
 * None for an empty term, and none when the host has no `openDirectory` (an older bridge): the options would only fail.
 */
export const serverSearchOptions = (filterText: string | undefined, available: boolean): ServerSearchOption[] => {
	const term = serverSearchTerm(filterText);
	if (!term || !available) return [];
	return [
		{ filter: 'rooms', term, label: `Public rooms matching ${term}` },
		{ filter: 'people', term, label: `People matching ${term}` },
	];
};

/** What makes an option reachable: Rocket.Chat's keyboard navigation only accepts `role="option"` nodes; the data attribute is row `search-server`. */
export const serverSearchAttributes = (option: ServerSearchOption) => ({
	role: 'option' as const,
	tabIndex: 0,
	'data-kit-server-search': option.filter,
});

/** Enter and Space activate an option (it is no link, so the browser does not). */
export const activatesOption = (key: string): boolean => key === 'Enter' || key === ' ';

/** The options of `bridge.openDirectory` for an option: Element's Spotlight with the term and the filter (rooms or people). */
export const searchHandOff = (option: ServerSearchOption): DirectoryOptions => ({ term: option.term, filter: option.filter });
