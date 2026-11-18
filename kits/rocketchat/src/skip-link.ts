// Pure part of the "Skip to main content" link (M12 Z1, patch reason class "D41 wire", see accessibility-shortcut.tsx): move
// keyboard focus to the room's main content. `<main id="main-content">` is not focusable on its own, so it gets tabindex="-1"
// for as long as it holds the focus (the usual skip-link pattern) and gives it back on blur: a click into the empty part of the
// main area then never leaves a focus ring on the whole region.
export const MAIN_CONTENT_ID = 'main-content';

/** What this module needs of a DOM element (kept structural so the unit test needs no DOM). */
export type FocusTarget = {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	addEventListener(type: 'blur', listener: () => void, options: { once: true }): void;
	focus(options?: { preventScroll?: boolean }): void;
};

export type FocusRoot = { getElementById(id: string): FocusTarget | null };

/** Focuses the main content of the page. Returns false when there is none (the click then does nothing, as before). */
export const focusMainContent = (root: FocusRoot): boolean => {
	const main = root.getElementById(MAIN_CONTENT_ID);
	if (!main) return false;
	if (main.getAttribute('tabindex') === null) {
		main.setAttribute('tabindex', '-1');
		main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
	}
	main.focus();
	return true;
};
