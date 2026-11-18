// Puts the text of a rejected send back into Rocket.Chat's composer (D21: a refused send leaves no ghost row, and it must
// not delete the only copy of what the user typed either). Rocket.Chat clears the composer before it posts and keeps no
// failed state for a message, so the text goes back where it came from. Only the composer of the room the send was for
// (the route names it); text typed since stays, the restored text goes before it.
import { getSource } from './adapter/bridge.ts';
import { roomPath } from './adapter/map.ts';
import { location } from './reload.ts';

const COMPOSER = 'footer.rc-message-box textarea[name="msg"]';

/** The composer text after a restore: the lost text first, whatever the user typed meanwhile after it. */
export const restoredText = (current: string, lost: string): string => (current.trim() ? `${lost}\n${current}` : lost);

/**
 * A route path with its percent-encoding undone until it is stable. Rocket.Chat's router encodes `+`, `%` and `/` of a
 * parameter twice while `roomPath` encodes once, so one decode of each leaves two different strings for the same room.
 */
export const settledPath = (path: string): string => {
	let cur = path;
	for (let i = 0; i < 4; i++) {
		let next: string;
		try {
			next = decodeURIComponent(cur);
		} catch {
			break;
		}
		if (next === cur) break;
		cur = next;
	}
	return cur;
};

// The textarea of the composer on screen for `rid`: the room is at the route and the textarea is mounted and in the document.
const composerOf = (rid: string, doc: Document): HTMLTextAreaElement | null => {
	const room = getSource().rooms().find((r) => r._id === rid);
	if (!room || settledPath(location.pathname) !== settledPath(roomPath(room))) return null;
	const input = doc.querySelector<HTMLTextAreaElement>(COMPOSER);
	return input?.isConnected ? input : null;
};

export const restoreComposerText = (rid: string, text: string, doc: Document = document): boolean => {
	if (!text.trim()) return false;
	const input = composerOf(rid, doc);
	if (!input) return false;
	// The native setter, so React's value tracking sees the change when the input event arrives (as the composer's own API).
	const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
	const value = restoredText(input.value, text);
	if (set) set.call(input, value);
	else input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	return true;
};

/**
 * Whether the composer on screen for `rid` still holds `text`. The route moves (`history.pushState`) before React commits the
 * room view, so a restore can write into the previous view's textarea, which is then unmounted: a restore counts as done only
 * when this is true a moment after the write (grok track F1).
 */
export const composerHolds = (rid: string, text: string, doc: Document = document): boolean => !!composerOf(rid, doc)?.value.includes(text);

/**
 * Rocket.Chat's own draft of a room (`useDraft`: `localStorage['messagebox_<rid>']`, the composer's initial value when the room's
 * composer mounts). Where the text of a rejected send survives when no composer on screen kept it; text already in the draft stays.
 */
export const saveRoomDraft = (rid: string, text: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void => {
	if (!text.trim()) return;
	const key = `messagebox_${rid}`;
	const current = storage.getItem(key) ?? '';
	if (current.includes(text)) return;
	storage.setItem(key, restoredText(current, text));
};
