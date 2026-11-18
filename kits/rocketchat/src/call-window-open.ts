// The call window's open/reuse/navigate logic, apart from React and Rocket.Chat so it runs in a unit test (the hook is
// `call-window.tsx`). The call app is another site, so the window it runs in must not reach back into this view: the named
// window is opened BLANK, its `opener` cut, and only then navigated to the call address (Rocket.Chat's own pattern in
// `useVideoConfOpenCall`: open, `opener = null`, set the location). A window already open is held and focused, not looked up
// by name again.

export const CONFERENCE_WINDOW_NAME = 'rocketchat-conference';

export type OpenerHost = {
	open: (url: string, name: string, features?: string) => Window | null;
};

export const isBlocked = (target: Window | null | undefined): target is null | undefined => !target || target.closed;

/** A function that opens (or reuses) the one named call window on an address and answers it, or null when a blocker stopped it. */
export const createCallWindowOpener = (host: OpenerHost, features: () => string): ((callUrl: string) => Window | null) => {
	let conferenceWindow: Window | null = null;
	let shownUrl = '';

	const cutOpener = (target: Window): void => {
		try {
			target.opener = null;
		} catch {
			// A window that cannot be reached cannot reach back either.
		}
	};

	return (callUrl) => {
		const current = isBlocked(conferenceWindow) ? null : conferenceWindow;
		if (current) {
			// The window this kit opened: held, not looked up by name (a lookup by name opens a second tab once the browser has
			// moved the call app into a browsing context group of its own).
			current.focus();
			// The same address: focus only. Another address: the same window navigates there.
			if (shownUrl !== callUrl) {
				current.location.href = callUrl;
				shownUrl = callUrl;
			}
			return current;
		}
		// Featured pop-out first; a blocked or already closed window falls back to the plain open, as Rocket.Chat's hook does.
		let target = host.open('', CONFERENCE_WINDOW_NAME, features());
		if (isBlocked(target)) target = host.open('', CONFERENCE_WINDOW_NAME);
		if (isBlocked(target)) {
			conferenceWindow = null;
			shownUrl = '';
			return null;
		}
		cutOpener(target);
		target.location.href = callUrl;
		conferenceWindow = target;
		shownUrl = callUrl;
		return target;
	};
};
