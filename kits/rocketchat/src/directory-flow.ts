// M10 W1 (patch reason class "D41 wire"): what the kit does with the outcome of Element's Directory (bridge.openDirectory).
// No Rocket.Chat imports, so the routing is unit-tested; directory-button.tsx and pages-stack-menu.tsx supply the real openers.
import type { ActionOutcome } from './bridge-types.ts';

export type DirectoryOptions = { term?: string; filter?: 'rooms' | 'people' };

export type DirectoryDeps = {
	directory: (opts: DirectoryOptions) => Promise<ActionOutcome>;
	/** True when the room is one of the kit's rooms (joined). */
	roomKnown: (rid: string) => boolean;
	openRoom: (rid: string) => void;
	/** The not-joined screen of a room the user only previews (sdk.ts `openPreview`). */
	openPreview: (rid: string) => void;
	/** A failed pick: the kit's error toast. */
	fail: (error: unknown) => void;
};

/** Opens Element's Directory; a picked room opens, a peeked one (not joined) opens its not-joined screen, a closed Directory does nothing. */
export const runDirectory = async (deps: DirectoryDeps, opts: DirectoryOptions = { filter: 'rooms' }): Promise<void> => {
	try {
		const outcome = await deps.directory(opts);
		if (outcome.status !== 'done' || !outcome.roomId) return;
		if (outcome.peek && !deps.roomKnown(outcome.roomId)) deps.openPreview(outcome.roomId);
		else deps.openRoom(outcome.roomId);
	} catch (error) {
		deps.fail(error);
	}
};
