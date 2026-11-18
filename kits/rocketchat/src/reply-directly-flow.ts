// M11 Y4 (patch reason class "D41 wire"): who gets "Reply in direct message", and what the kit does with the outcome of Element's
// direct chat (bridge.startDm). No Rocket.Chat imports, so the decision is unit-tested; reply-directly-action.ts supplies the real hooks.
// There is no quote: a message quoted into another room has no Matrix form, so the press only opens (or starts) the chat.
import type { ActionOutcome } from './bridge-types.ts';

export type ReplyDirectlyGate = {
	/** Rocket.Chat's own decision (a subscription, not a direct room, not embedded); false when it offers no item. */
	original: boolean;
	/** The host has `startDm` (bridge before M11 Y4: no item). */
	canStartDm: boolean;
	/** The message sender's user id (N6: your own message gets no item, there is no chat with yourself). */
	senderId: string;
	ownId: string | undefined;
};

export const replyDirectlyShown = (g: ReplyDirectlyGate): boolean => g.original && g.canStartDm && !!g.senderId && g.senderId !== g.ownId;

export type ReplyDirectlyDeps = {
	/** `fromRoomId`: the room of the message replied to (M12 Z2 F1), so a new chat is titled with the person on that message. */
	startDm: (userId: string, fromRoomId?: string) => Promise<ActionOutcome>;
	openRoom: (rid: string) => void;
	/** A failed chat: the kit's error toast. */
	fail: (error: unknown) => void;
};

/**
 * Opens, or starts, the direct chat with `userId`; the chat opens once the kit has it, a backed-out dialog does nothing.
 * `fromRoomId` is the room of the message the user replied to (M12 Z2 F1).
 */
export const runReplyDirectly = async (deps: ReplyDirectlyDeps, userId: string, fromRoomId?: string): Promise<void> => {
	try {
		const outcome = await deps.startDm(userId, fromRoomId);
		if (outcome.status !== 'done' || !outcome.roomId) return;
		deps.openRoom(outcome.roomId);
	} catch (error) {
		deps.fail(error);
	}
};
