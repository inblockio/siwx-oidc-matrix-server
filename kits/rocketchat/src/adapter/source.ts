// Rocket.Chat-shaped documents kept in step with the bridge. The adapter's only input is the bridge (D7).
import type { IMessage, IRoom, ISubscription, IUser } from '@rocket.chat/core-typings';

import type { ActionOutcome, ClientViewBridge, LoadOlderResult, ViewAnchor, ViewPanelCard, ViewConnection, ViewMessage, ViewNotificationLevel, ViewRoom, ViewSection, ViewSettingsTab } from '../bridge-types.ts';
import { avatarFor, encryptionLine, errorText, initialAvatar, isNoMessageEvent, newOwnReactionNames, reactionKeyFor, slugs, toMessage, toRoom, toSender, toSubscription, toUser, toVideoConference } from './map.ts';

export type Doc = IRoom | ISubscription | IMessage | IUser;
export type Change = { kind: 'room' | 'subscription' | 'message' | 'user'; op: 'changed' | 'removed'; doc: Doc } | { kind: 'videoconf'; op: 'changed'; doc: { rid: string; callId: string } };

/** Pages `ensureMessage` asks for at most (the host's window limit ends it sooner). */
const MAX_JUMP_PAGES = 200;

/** Rocket.Chat's REST error shape (`success: false`, `error`, `errorType`, also under `xhr.responseJSON` for its error handler). */
export class ReactError extends Error {
	public readonly success = false;
	public readonly error: string;
	public readonly code: string;
	public readonly errorType: string;
	public readonly xhr: { responseJSON: { success: false; error: string; errorType: string } };
	public constructor(code: string, errorType: string, message: string) {
		super(message);
		this.code = code;
		this.errorType = errorType;
		this.error = message;
		this.xhr = { responseJSON: { success: false, error: message, errorType } };
	}
}

/**
 * The host refuses a second dialog action while one still runs (`dialogAction`, RoomActions.ts: code `failed`, this fixed text; the
 * lock is held for up to ~5 s after Element's own dialog closed without a pick). M11 Y1: the user sees a plain sentence, as for
 * `CANNOT_FORWARD`, never Element's raw message. It serves every action that opens an Element dialog.
 */
const HOST_DIALOG_BUSY = 'another Element dialog action is running';
export const DIALOG_BUSY = 'Element is still finishing the last dialog. Try again in a moment.';
/**
 * Duck-typed on the message, never `instanceof Error`: the kit runs in an iframe and the host's failure is an error object of the
 * HOST window's realm, so `instanceof Error` is false here (found by the first y1-dialog-busy run: the toast showed the raw text).
 */
export const isDialogBusy = (error: unknown): boolean => String((error as { message?: unknown } | null)?.message ?? error).includes(HOST_DIALOG_BUSY);

const fromAction = (e: unknown): ReactError => {
	const code = (e as { code?: unknown }).code;
	const message = isDialogBusy(e) ? DIALOG_BUSY : errorText(e);
	return new ReactError(typeof code === 'string' ? code : 'failed', typeof code === 'string' ? `error-${code}` : 'error-failed', message);
};

/** Element offers no Forward for a message of this kind (a poll, a message that is not actionable): a plain sentence, not a raw error. */
export const CANNOT_FORWARD = "This message can't be forwarded";

/** What the Forward button toasts for a failed `openForward`. */
export const forwardFailure = (error: unknown): unknown => ((error as { code?: unknown }).code === 'unsupported' ? CANNOT_FORWARD : error);

/** The host cannot move this category (unknown, already first or last, no category move in the host): a plain sentence, not a raw error. */
export const CANNOT_MOVE = "This category can't be moved";

/** The host did not answer in time or `sections()` did not show the new order: the write may still have landed, so the sentence claims neither outcome. */
export const MOVE_NOT_SAVED = 'The new category order could not be confirmed. Check the list and try again.';

/** What the Move up / Move down item toasts for a failed `moveSection`: code `network` is "could not be confirmed, check the list", anything else "can't be moved". */
export const moveFailure = (error: unknown): string => ((error as { code?: unknown } | null | undefined)?.code === 'network' ? MOVE_NOT_SAVED : CANNOT_MOVE);

/** Element offers no thread for a message of this kind (a state event, no server-side thread support): a plain sentence, not a raw error. */
export const CANNOT_THREAD = "This message can't be replied to in a thread";

/** What the Reply in thread button toasts for a failed `openThread`. */
export const threadFailure = (error: unknown): unknown => ((error as { code?: unknown }).code === 'unsupported' ? CANNOT_THREAD : error);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const OLDER_FAILED = 'older messages could not be loaded';

/** The first answer's cursor when no message is loaded yet: later than any message. */
const NOT_LOADED_CURSOR = '9999-12-31T23:59:59.999Z';

// M7 E2: an MXID counts as a mention token when no id character comes before it and none (nor `.` / `:` + one) after it.
const ID_CHAR = /[A-Za-z0-9_=/+-]/;
const hasToken = (text: string, id: string): boolean => {
	for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
		const before = text[at - 1];
		const after = text[at + id.length];
		const next = text[at + id.length + 1];
		if ((before && ID_CHAR.test(before)) || (after && ID_CHAR.test(after)) || (after && /[.:]/.test(after) && next && /[A-Za-z0-9]/.test(next))) continue;
		return true;
	}
	return false;
};

// M7 E2: the user pills of a message's formatted body (`<a href="https://matrix.to/#/@id">Name</a>`): the ids an edit carries on.
// Only `@`-user links count (never a room or event link) and only an id that is a Matrix user id; an id is a list entry for the
// bridge, never text of the edit.
const PILL = /<a\s+href="https:\/\/matrix\.to\/#\/((?:@|%40)[^"]+)"[^>]*>([^<]*)<\/a>/g;
const MXID = /^@[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const unescapeHtml = (t: string): string => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const pillsOf = (formattedBody: string | undefined): { id: string; name: string }[] => {
	const found: { id: string; name: string }[] = [];
	if (!formattedBody) return found;
	for (const pill of formattedBody.matchAll(PILL)) {
		let id: string;
		try {
			id = decodeURIComponent(pill[1]);
		} catch {
			continue;
		}
		if (MXID.test(id) && !found.some((x) => x.id === id)) found.push({ id, name: unescapeHtml(pill[2]) });
	}
	return found;
};
// The row shows a pill as its name, so an edit box holds the name: it counts while the name is still a word of the text.
const nameAt = (text: string, name: string): number => {
	if (!name) return -1;
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
		if (/[\p{L}\p{N}_]/u.test(text[at - 1] ?? '') || /[\p{L}\p{N}_]/u.test(text[at + name.length] ?? '')) continue;
		return at;
	}
	return -1;
};

export class BridgeSource {
	private readonly offered = new Map<string, Map<string, number>>();
	/** Per room: the stamp up to which a send dropped the offers (a candidate answer at or below it is discarded). */
	private readonly dropped = new Map<string, number>();
	/** Stamps the offers in order: a send / edit that finishes drops only the offers made before it started. */
	private offerClock = 0;
	public me: IUser;
	private viewRooms: ViewRoom[] = [];
	/** M6 B1: the host's custom sections; undefined for a host that has none (before M6). */
	private viewSections: ViewSection[] | undefined;
	private roomDocs = new Map<string, IRoom>();
	private subDocs = new Map<string, ISubscription>();
	/** Room id -> the `_updatedAt` a renamed room's subscription was given (later than the one it replaced). */
	private subStamps = new Map<string, number>();
	private messages = new Map<string, Map<string, IMessage>>();
	private senders = new Map<string, ViewMessage>();
	/** Message id -> the sender avatar its row was last drawn with (Rocket.Chat reads the avatar at render time). */
	private rowAvatars = new Map<string, string | undefined>();
	/** Call id -> the call root message as the bridge last handed it over (what `video-conference.info` answers from). */
	private callViews = new Map<string, ViewMessage>();
	/** Call id -> room id of a call this kit started and the bridge has not shown yet (`video-conference.start`). */
	private startedCalls = new Map<string, string>();
	/** Call id -> when the kit saw the call end (the start when it first saw the call already ended). No view-model has an end time. */
	private callEnds = new Map<string, number>();
	/** Participant user id -> avatar URL of the call card's face pile (a participant who never wrote has no sender row). */
	private callAvatars = new Map<string, string>();
	/** The last view of each message the kit saw: what a press falls back to once the message left the snapshot. */
	private lastViews = new Map<string, ViewMessage>();
	/** Room id -> when the kit first saw the room read (`ls` of a read room, F3). */
	private readAt = new Map<string, number>();
	/**
	 * Messages the user sent from Rocket.Chat: the Matrix event id -> the `_id` Rocket.Chat gave the message. The row that
	 * confirms a send keeps that `_id`, so Rocket.Chat's own store replaces its optimistic copy (`temp: true`, same `_id`,
	 * as with a Rocket.Chat server, which keeps the client's `_id`) and never shows a second row.
	 */
	private rcIds = new Map<string, string>();
	/** The other direction, for lookups by the `_id` Rocket.Chat knows. */
	private eventIds = new Map<string, string>();
	/**
	 * Sends in flight, `_id` -> room: a snapshot row whose `txnId` is one of them is that message's confirmation. While a
	 * room has one, the user's own rows without that mapping are held back (see `syncTimeline`).
	 */
	private pendingSends = new Map<string, { rid: string; rcId: string }>();
	/**
	 * The last send of a room that failed with no echo to show for it, room -> its text and the transaction id it used.
	 * The homeserver may hold that message although the answer was lost: a resend of the same text reuses the transaction
	 * id, so the homeserver answers with the first event instead of posting a duplicate (grok track F1).
	 */
	private failedSends = new Map<string, { text: string; replyTo: string | undefined; txnId: string }>();
	/**
	 * A local chat that became a real room, local id -> real id (a send of it named the room). The composer may still address
	 * the local id while the kit moves to the real room, and the host sends to the real room from either: `failedSends` is
	 * kept under the real id, so a send finds, reuses and settles the stored transaction id by whichever id the composer has.
	 */
	private createdAs = new Map<string, string>();
	/**
	 * Rooms where older messages are being loaded, room -> the timeline's message ids when it began. The host names the ids a
	 * page added (`LoadOlderResult.ids`): those are history for the `/v1/rooms.history` answer, whatever their time, and any
	 * other new message is live. A message first seen while the load runs is held (`olderHeld`) until the host answers. Only
	 * a host that gives no ids falls back to position: before the first prior message is history (the timeline is sorted by
	 * time there, so an older event with a later time is misread, which is why the ids exist).
	 */
	private olderPrior = new Map<string, Set<string>>();
	/** Messages first seen while older ones load, room -> message id -> document and the position rule's verdict. */
	private olderHeld = new Map<string, Map<string, { doc: IMessage; history: boolean }>>();
	/** Older messages loaded and not yet answered by `historyBefore`, room -> document ids. */
	private olderPending = new Map<string, Set<string>>();
	/** An older-history load in flight per room: a second ask (Rocket.Chat clears and asks again) shares it. */
	private olderLoads = new Map<string, Promise<LoadOlderResult>>();
	/** Rooms whose last older-history ask failed, room -> when. Rocket.Chat asks again on every list change; see `historyBefore`. */
	private olderFailedAt = new Map<string, number>();
	/** How long after a failed ask the next one is refused without trying the host again (no request storm while it is down). */
	public olderRetryAfterMs = 5000;
	private listeners = new Set<(c: Change) => void>();
	private connListeners = new Set<(c: ViewConnection) => void>();
	private reactionListeners = new Set<(name: string) => void>();

	private readonly bridge: ClientViewBridge;
	private readonly epoch: number;

	public constructor(bridge: ClientViewBridge, epoch = Date.now()) {
		this.bridge = bridge;
		this.epoch = epoch;
		this.me = toUser(bridge.me(), bridge.sections?.());
		this.syncRooms(false);
		bridge.onChange((e) => {
			if (e.kind === 'rooms') this.syncRooms(true);
			else if (e.kind === 'timeline' && e.roomId) this.syncTimeline(e.roomId, true);
			else if (e.kind === 'me') this.syncMe();
			else if (e.kind === 'connection') {
				const c = bridge.connection();
				this.connListeners.forEach((cb) => cb(c));
			}
		});
	}

	public rooms(): IRoom[] {
		return [...this.roomDocs.values()];
	}

	public subscriptions(): ISubscription[] {
		return [...this.subDocs.values()];
	}

	/** Oldest first. Starts the room's timeline in the host on first use. */
	public history(rid: string): IMessage[] {
		this.syncTimeline(rid, false);
		return [...(this.messages.get(rid)?.values() ?? [])].sort((a, b) => +a.ts - +b.ts);
	}

	/** The rows Rocket.Chat has been shown, oldest first: not those held back while `loadOlder` runs or kept for its next page. */
	private seen(rid: string): IMessage[] {
		const hidden = new Set(this.olderPending.get(rid));
		for (const h of this.olderHeld.get(rid)?.values() ?? []) hidden.add(h.doc._id);
		return this.history(rid).filter((m) => !hidden.has(m._id));
	}

	/**
	 * One page of Rocket.Chat's `/v1/rooms.history`. Without `previous` (the first page) it is every loaded message; with it
	 * (the cursor an earlier answer gave, an ISO time) the host first loads older messages, then the loaded ones older than
	 * the cursor are answered. The answer's cursor is the oldest message's time, so Rocket.Chat asks again when the user
	 * scrolls up, and `null` at the room's start or the host's window limit, or when nothing older arrived.
	 */
	public async historyBefore(rid: string, previous?: string): Promise<{ messages: IMessage[]; previous: string | null }> {
		if (!previous) {
			const all = this.history(rid);
			this.olderPending.delete(rid);
			// Nothing loaded yet is the usual first answer (the host's first window arrives a moment later, as stream messages).
			// A cursor past every message makes Rocket.Chat ask again at once: that second request waits for the window and
			// answers it, and ends at the room's start when there is none.
			return { messages: all, previous: all.length > 0 ? new Date(all[0].ts).toISOString() : NOT_LOADED_CURSOR };
		}
		const cursor = Date.parse(previous);
		if (Number.isNaN(cursor)) throw Object.assign(new Error('invalid cursor'), { code: 'failed' });
		const failedAt = this.olderFailedAt.get(rid);
		if (failedAt !== undefined && Date.now() - failedAt < this.olderRetryAfterMs) throw new Error(OLDER_FAILED);
		// Older than the cursor by time, or loaded as history since the last answer (an older event can carry a later time).
		const older = () => this.history(rid).filter((m) => +m.ts < cursor || !!this.olderPending.get(rid)?.has(m._id));
		let end = false;
		// A page can hold nothing showable (hidden events): ask a few times before giving up.
		for (let tries = 0; tries < 3 && !end && older().length === 0; tries++) {
			const r = await this.loadOlder(rid);
			end = r.atStart || r.atLimit;
			if (end) break;
		}
		const messages = older();
		// Nothing came and the host is not at an end: its page failed (or held nothing showable). An error leaves Rocket.Chat's
		// cursor as it was, so the next scroll asks again; an empty answer would make it ask again at once, endlessly.
		if (messages.length === 0 && !end) {
			this.olderFailedAt.set(rid, Date.now());
			throw Object.assign(new Error(OLDER_FAILED), { code: 'failed' });
		}
		this.olderFailedAt.delete(rid);
		for (const m of messages) this.olderPending.get(rid)?.delete(m._id);
		// The cursor only moves back: a page of events that carry later times than it leaves it where it was.
		return { messages, previous: end ? null : new Date(Math.min(cursor, +messages[0].ts)).toISOString() };
	}

	/** Loads a page of older messages in the host (`bridge.loadOlder`); the messages are kept, and answered by `historyBefore`. */
	public loadOlder(rid: string): Promise<LoadOlderResult> {
		if (typeof this.bridge.loadOlder !== 'function') return Promise.reject(Object.assign(new Error('older history needs bridge version 2'), { code: 'unsupported' }));
		const running = this.olderLoads.get(rid);
		if (running) return running;
		this.syncTimeline(rid, false);
		this.olderPrior.set(rid, new Set(this.bridge.timeline(rid).map((m) => m.id)));
		const settle = (ids?: string[]) => {
			this.syncTimeline(rid, false);
			this.settleOlder(rid, ids ? new Set(ids) : undefined);
			this.olderPrior.delete(rid);
			this.olderLoads.delete(rid);
		};
		const load = this.bridge.loadOlder(rid).then(
			(r) => {
				settle(r.ids);
				return r;
			},
			(e: unknown) => {
				settle();
				throw e;
			},
		);
		this.olderLoads.set(rid, load);
		return load;
	}

	/**
	 * The jump to a message (Rocket.Chat's `chat.getMessage` before it scrolls): the message when loaded, else older history is
	 * paged in (`loadOlder`) until it is, the room starts or the host's window limit. Undefined when it did not come.
	 */
	public async ensureMessage(rid: string, id: string): Promise<IMessage | undefined> {
		for (let pages = 0; pages < MAX_JUMP_PAGES; pages++) {
			const found = this.message(id);
			if (found) return found;
			const r = await this.loadOlder(rid);
			if (r.atStart || r.atLimit) break;
		}
		return this.message(id);
	}

	/** Every loaded message of a room, for a jump (`rooms.history` with `aroundId`): the live window, nothing newer to page. */
	public windowAround(rid: string): { messages: IMessage[]; previous: string | null } {
		const all = this.history(rid);
		this.olderPending.delete(rid);
		return { messages: all, previous: all.length > 0 ? new Date(all[0].ts).toISOString() : null };
	}

	/** A loaded message by id alone, in any room (Rocket.Chat's jump to a message reads it before it scrolls). */
	public message(id: string): IMessage | undefined {
		const eventId = this.eventIds.get(id) ?? id;
		for (const known of this.messages.values()) {
			const m = known.get(eventId);
			if (m) return m;
		}
		return undefined;
	}

	/** A user by id or username (both are the Matrix user id here): the signed-in user or a message sender. */
	public user(key: string): IUser | undefined {
		if (key === this.me._id) return this.me;
		const m = this.senders.get(key);
		return m ? toSender(m) : undefined;
	}

	/** An avatar for a user or room key; an initial avatar when the view-models have none. */
	public avatar(key: string): string {
		const url = avatarFor(key, { me: this.bridge.me(), rooms: this.viewRooms, senders: this.senders }) ?? this.callAvatars.get(key);
		if (url) return url;
		const label = this.roomDocs.get(key)?.fname ?? this.user(key)?.name ?? key;
		return initialAvatar(label);
	}

	/** The call app's address from the host config, or undefined: no call is offered (C5). */
	public meetUrl(): string | undefined {
		const url = typeof this.bridge.meetUrl === 'function' ? this.bridge.meetUrl() : undefined;
		return url || undefined;
	}

	/** The call the bridge shows running in a room (the newest when it shows several), else undefined. */
	public ongoingCall(rid: string): string | undefined {
		let found: ViewMessage | undefined;
		for (const m of this.callViews.values()) {
			if (m.roomId === rid && m.call?.state === 'ongoing' && (!found || m.call.startedTs >= found.call!.startedTs)) found = m;
		}
		return found?.call?.callId;
	}

	/** Remembers the room of a call this kit started (no call root exists yet); `callRoom` finds the room of any call. */
	public bindCall(callId: string, rid: string): void {
		this.startedCalls.set(callId, rid);
	}

	/** The room of a call: the bridge's call root, else a call this kit started. */
	public callRoom(callId: string): { rid: string; ended: boolean } | undefined {
		const m = this.callViews.get(callId);
		if (m?.call) return { rid: m.roomId, ended: m.call.state === 'ended' };
		const rid = this.startedCalls.get(callId);
		return rid ? { rid, ended: false } : undefined;
	}

	/** Rocket.Chat's `VideoConference` of a call the bridge handed over (`video-conference.info`), else undefined. */
	public videoConference(callId: string): Record<string, unknown> | undefined {
		const m = this.callViews.get(callId);
		if (!m?.call) return undefined;
		return toVideoConference(m, this.callEnds.get(callId) ?? m.call.startedTs);
	}

	public markRead(rid: string): void {
		this.bridge.markRead(rid);
	}

	/**
	 * M7 E2: the members the composer's `@` popup offered in this room (the bridge's answer, kept per room): the
	 * Rocket.Chat popup lists them as `users` and inserts the MXID text; what is picked is told from the draft at send time.
	 */
	public async mentionCandidates(rid: string, query: string): Promise<{ userId: string; displayName: string }[]> {
		if (typeof this.bridge.mentionCandidates !== 'function') throw Object.assign(new Error('mentions need a newer bridge'), { code: 'unsupported' });
		// The stamp is the request's start: a send that began after it (answer in its flight) owns the pick, one that began before does not.
		const stamp = ++this.offerClock;
		const found = await this.bridge.mentionCandidates(rid, query);
		// A send that began after this request already dropped up to the watermark: the late answer is no pick of the next draft.
		if (stamp <= (this.dropped.get(rid) ?? 0)) return found;
		const known = this.offered.get(rid) ?? new Map<string, number>();
		for (const c of found) known.set(c.userId, Math.max(stamp, known.get(c.userId) ?? 0));
		this.offered.set(rid, known);
		return found;
	}

	/**
	 * The mention ids of `text` in `rid`: the members the popup offered in this draft, plus `own` (the edited message's own
	 * mentions), whose MXID is still a token of `text` (the pick stays in the draft), in order of first use.
	 */
	public mentionsIn(rid: string, text: string, own: Iterable<string> = []): string[] {
		const ids = new Set<string>([...(this.offered.get(rid)?.keys() ?? []), ...own]);
		return [...ids].filter((id) => hasToken(text, id)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
	}

	/** A local chat became the real room: the offers of its draft follow the room id. */
	public moveOffered(from: string, to: string): void {
		if (from === to) return;
		const mark = this.dropped.get(from);
		if (mark !== undefined) {
			this.dropped.delete(from);
			this.dropped.set(to, Math.max(mark, this.dropped.get(to) ?? 0));
		}
		const moved = this.offered.get(from);
		if (!moved) return;
		this.offered.delete(from);
		const known = this.offered.get(to) ?? new Map<string, number>();
		for (const [id, stamp] of moved) known.set(id, Math.max(stamp, known.get(id) ?? 0));
		this.offered.set(to, known);
	}

	/** Drops the offers of `rid` stamped at or before `upTo` (the sent draft's); later picks belong to the next draft. */
	private dropOffers(rid: string, upTo: number): void {
		this.dropped.set(rid, Math.max(upTo, this.dropped.get(rid) ?? 0));
		const known = this.offered.get(rid);
		if (!known) return;
		for (const [id, stamp] of known) if (stamp <= upTo) known.delete(id);
		if (!known.size) this.offered.delete(rid);
	}

	/** The Matrix event id of a message by the `_id` Rocket.Chat knows it by (the same id unless the user sent it here). */
	public eventIdOf(id: string): string {
		return this.eventIds.get(id) ?? id;
	}

	/**
	 * Sends a Rocket.Chat composer message (CommonMark, `markdown: true`: the caller has mapped the dialect, E1), with Rocket.Chat's `_id` as the transaction id; `replyTo` is the
	 * `_id` of the message the composer quoted (a reply, A3). Resolves with the bridge's outcome; the confirming row
	 * (before or after this resolves) replaces the optimistic copy.
	 */
	public async sendText(rid: string, text: string, rcId: string, replyTo?: string): Promise<ActionOutcome> {
		const mentions = this.mentionsIn(rid, text);
		const started = this.offerClock;
		if (typeof this.bridge.sendText !== 'function') throw Object.assign(new Error('sending needs bridge version 2'), { code: 'unsupported' });
		// The transaction id: Rocket.Chat's `_id`, or that of an earlier failed send of the same text AND reply in this room
		// (a different quote is a different message: the homeserver would answer the first event and drop the new relation).
		const replyEvent = replyTo ? this.eventIdOf(replyTo) : undefined;
		const slot = this.createdAs.get(rid) ?? rid;
		const failed = this.failedSends.get(slot);
		const reuse = !!failed && failed.text === text && failed.replyTo === replyEvent;
		const txnId = reuse ? failed.txnId : rcId;
		this.pendingSends.set(txnId, { rid, rcId });
		let sentRoom: string | undefined;
		let failedIn: string | undefined;
		try {
			const outcome = await this.bridge.sendText(rid, text, { txnId, markdown: true, ...(replyEvent ? { replyTo: replyEvent } : {}), ...(mentions.length ? { mentions } : {}) });
			sentRoom = outcome.roomId;
			// The offers belong to the draft that was sent: a later hand-typed MXID is no pick.
			if (outcome.status === 'done') this.dropOffers(rid, started);
			// Only the send that used the stored transaction id settles it: any other send leaves it for the retry.
			if (reuse) this.failedSends.delete(slot);
			if (outcome.status === 'done' && outcome.eventId) this.adopt(outcome.roomId ?? rid, outcome.eventId, rcId);
			return outcome;
		} catch (e) {
			// The homeserver may hold the message although the call failed (the answer was lost, the echo came first): the
			// truth is the timeline (D21), so a row whose echo carries this transaction id stays, shown under the `_id`.
			// M13 U3 (D2): a failed first send in a created local chat names the real room (`roomId` of the host's error): the
			// message lives, and a resend goes, in THAT room, so the echo check and the stored transaction id are its.
			const named = (e as { roomId?: unknown } | null)?.roomId;
			failedIn = typeof named === 'string' && named !== rid ? named : undefined;
			const where = failedIn ?? sentRoom ?? slot;
			if (failedIn) this.createdAs.set(rid, failedIn);
			const held = this.bridge.timeline(where).find((m) => m.txnId === txnId);
			if (held) {
				this.dropOffers(rid, started);
				if (reuse) this.failedSends.delete(slot);
				this.adopt(where, held.id, rcId);
				return { status: 'done', roomId: where, eventId: held.id };
			}
			// D21: a refused send leaves no ghost. Rocket.Chat's own failed-send path only toasts the error and keeps its
			// optimistic row (`temp: true`), so the row is withdrawn with Rocket.Chat's delete notification.
			this.emit({ kind: 'message', op: 'removed', doc: { _id: rcId, rid } as IMessage });
			this.failedSends.set(where, { text, replyTo: replyEvent, txnId });
			throw e;
		} finally {
			this.pendingSends.delete(txnId);
			// Rows held back while the send was in flight and never adopted (sent from another device) show now.
			for (const room of new Set([rid, sentRoom, failedIn])) if (room && this.messages.has(room) && !this.sendPending(room)) this.syncTimeline(room, true);
		}
	}

	/**
	 * Rocket.Chat's `chat.update`: replaces the text of the user's own message `mid` (A11). The bridge resolves once the
	 * homeserver holds the replacement; the edited row arrives as a change of the timeline (never an optimistic copy), so a
	 * refused edit leaves the message as the homeserver has it.
	 */
	public async editText(mid: string, text: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.editText !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'editing needs bridge version 2');
		try {
			const started = this.offerClock;
			// The message's own mentions are the pills of its formatted body (the row carries no RC mention entry).
			const own = pillsOf(this.viewMessage(known.rid, this.eventIdOf(mid))?.formattedBody);
			const mentions = this.mentionsIn(known.rid, text, own.map((x) => x.id));
			const named = own.filter((x) => !mentions.includes(x.id)).map((x) => ({ id: x.id, at: nameAt(text, x.name), end: nameAt(text, x.name) + x.name.length })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
			// The host pills only an id token: each kept name goes out as its id (last first, so offsets hold); an overlapping later one is dropped.
			const byName: typeof named = [];
			for (const x of named) if (x.at >= (byName.at(-1)?.end ?? 0)) byName.push(x);
			let out = text;
			for (const x of [...byName].reverse()) out = out.slice(0, x.at) + x.id + out.slice(x.end);
			mentions.push(...byName.map((x) => x.id));
			const outcome = await this.bridge.editText(known.rid, this.eventIdOf(mid), out, { markdown: true, ...(mentions.length ? { mentions } : {}) });
			if (outcome.status === 'done') this.dropOffers(known.rid, started);
			return outcome;
		} catch (e) {
			throw fromAction(e);
		}
	}

	/**
	 * Rocket.Chat's `chat.delete`: deletes the user's own message `mid` (A12), after Rocket.Chat's own confirmation. The row
	 * goes when the redaction arrives in the timeline (`syncTimeline`), not before: a refused delete leaves the message.
	 */
	public async deleteMessage(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.redact !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'deleting needs bridge version 2');
		try {
			return await this.bridge.redact(known.rid, this.eventIdOf(mid));
		} catch (e) {
			throw fromAction(e);
		}
	}

	/**
	 * Rocket.Chat's `chat.pinMessage` / `chat.unPinMessage`: pins or unpins the message `mid` (M6 B2) through the host's
	 * pin action. Rocket.Chat shows its own optimistic mark and takes it back on an error; the kept mark is the one the
	 * homeserver's pinned list gives (the timeline carries `pinned`), so a refused pin leaves none.
	 */
	public async setPinned(mid: string, on: boolean): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.setPinned !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'pinning needs bridge version 2 with pin');
		try {
			return await this.bridge.setPinned(known.rid, this.eventIdOf(mid), on);
		} catch (e) {
			throw fromAction(e);
		}
	}

	private sendPending(rid: string): boolean {
		for (const send of this.pendingSends.values()) if (send.rid === rid) return true;
		return false;
	}

	/** Event `eventId` is Rocket.Chat's message `rcId`. A row already shown under the event id is withdrawn first. */
	private adopt(rid: string, eventId: string, rcId: string): void {
		if (this.rcIds.get(eventId) === rcId) return;
		this.rcIds.set(eventId, rcId);
		this.eventIds.set(rcId, eventId);
		const shown = this.messages.get(rid)?.get(eventId);
		if (shown && shown._id !== rcId) {
			this.messages.get(rid)!.delete(eventId);
			this.emit({ kind: 'message', op: 'removed', doc: shown });
		}
		this.syncTimeline(rid, true);
	}

	/**
	 * The loaded message with the Matrix view of its reactions (the key a name maps to depends on it). A message the kit
	 * keeps after it left the snapshot (the host's window trimmed it) falls back to the last view the kit saw of it.
	 */
	private viewMessage(rid: string, mid: string): ViewMessage | undefined {
		const view = this.bridge.timeline(rid).find((m) => m.id === mid);
		if (view) this.lastViews.set(mid, view);
		return view ?? this.lastViews.get(mid);
	}

	/**
	 * Rocket.Chat's `chat.react`: toggles the user's reaction `name` (`:thumbsup:`) on a message. The message must be a
	 * loaded one; the name maps back to the Matrix key (an unknown name is Rocket.Chat's "Invalid emoji" error).
	 */
	public async react(mid: string, name: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		// Rocket.Chat's quick reaction (`+:name:` in the composer) aims at the newest loaded message, system lines included (the
		// encryption line, the call card, an undecryptable or still-waiting message): a row with no react control, that has no Matrix
		// reaction target of its own. Element's (SendMessageComposer.sendQuickReaction) picks the target itself, newest first the
		// first `m.room.message` event of the live timeline (a failed decrypt included), and does nothing when there is none: the
		// host's `quickReact` runs that rule (M13 U6), the kit picks no target (stock parity). Only the newest message of the room is
		// a press `+:name:` can send (`findLastMessage`); a toolbar or chip click on any older skipped message keeps its own id, the
		// host answers `forbidden` as Element has no react control there, and no other message is written.
		// M13 U5: "newest" is Rocket.Chat's view, the rows it has been shown, by time (`findLastMessage` keeps the FIRST record of
		// a tie, the kit's `at(-1)` is the last stored; a row held back during `loadOlder` is stored but not shown to it yet).
		if (isNoMessageEvent(known)) {
			const skipped = known;
			if (!this.seen(skipped.rid).some((m) => +m.ts > +skipped.ts)) {
				// Rocket.Chat's optimistic update already put the chip on the skipped message and never rolls it back: its own kit
				// document (no reactions) replaces that record, before the write, so a refusal leaves no ghost chip.
				this.emit({ kind: 'message', op: 'changed', doc: skipped });
				const quick = reactionKeyFor(this.viewMessage(skipped.rid, this.eventIdOf(skipped._id)), name);
				if (!quick) throw new ReactError('invalid_emoji', 'error-not-allowed', 'Invalid emoji provided.');
				// A host without `quickReact` writes nothing rather than a reaction on the wrong message.
				if (typeof this.bridge.quickReact !== 'function') return { status: 'done' };
				try {
					return await this.bridge.quickReact(skipped.rid, quick);
				} catch (e) {
					throw fromAction(e);
				}
			}
		}
		// The timeline and the bridge know the event id; Rocket.Chat's `_id` of the user's own sent message is another id.
		const ev = this.eventIdOf(known._id);
		const key = reactionKeyFor(this.viewMessage(known.rid, ev), name);
		if (!key) throw new ReactError('invalid_emoji', 'error-not-allowed', 'Invalid emoji provided.');
		try {
			return await this.bridge.react(known.rid, ev, key);
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** Element's reaction picker over the kit, anchored at a control of the kit (the add-reaction buttons). */
	public async openReactionPicker(mid: string, anchor: ViewAnchor): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		try {
			return await this.bridge.openReactionPicker(known.rid, this.eventIdOf(mid), anchor);
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** Element's report dialog over the kit (M7 E4): `done` when it closes; reporting an own message is `forbidden`. */
	public async openReport(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.openReport !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'reporting needs a host with openReport');
		try {
			return await this.bridge.openReport(known.rid, this.eventIdOf(mid));
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** Element's View source dialog over the kit for one message; read-only, `done` when it closes. */
	public async openViewSource(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		try {
			return await this.bridge.openViewSource(known.rid, this.eventIdOf(mid));
		} catch (e) {
			throw fromAction(e);
		}
	}

	/**
	 * Element's "Copy Markdown" (M14 K6): the host puts the message's Markdown on the clipboard (`done`). Nothing is awaited
	 * before the bridge call, so it runs in the click's call stack (the clipboard needs the user gesture).
	 */
	public async copyMarkdown(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.copyMarkdown !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'copying Markdown needs a host with copyMarkdown');
		try {
			return await this.bridge.copyMarkdown(known.rid, this.eventIdOf(mid));
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** The room Element's thread panel is open in (M8 T1), else undefined. */
	private threadRid: string | undefined;
	/** Counts `openThread` calls: a late answer of an older call must not touch what a newer call set. */
	private threadSeq = 0;

	/**
	 * Element's thread panel over the kit for one message (M8 T1): `done` when the panel closes. The panel sends the thread
	 * replies itself and the kit's row follows the timeline (`thread`), so the kit keeps no state but the room it is open in.
	 * A refused call leaves the panel that was already open (and the room it is open in) as it was.
	 */
	public async openThread(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		if (typeof this.bridge.openThread !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'a thread panel needs a host with openThread');
		const previous = this.threadRid;
		const seq = ++this.threadSeq;
		this.threadRid = known.rid;
		try {
			const out = await this.bridge.openThread(known.rid, this.eventIdOf(mid));
			if (this.threadSeq === seq) this.threadRid = undefined; // `done`: the panel of this call closed
			return out;
		} catch (e) {
			if (this.threadSeq === seq) this.threadRid = previous;
			throw fromAction(e);
		}
	}

	/**
	 * Rocket.Chat's router moved (M8 T1): the thread panel belongs to the room it was opened in, so it closes when the route
	 * shows another room or a page that is no room (Home, directory). A room route carries the room's `rid` (direct) or its
	 * `name` (channel, group); the tab and context of the same room keep the panel.
	 */
	public routeChanged(params: { rid?: string; name?: string }): void {
		const leaves = (rid: string | undefined): boolean => {
			if (!rid || params.rid === rid) return false;
			const name = this.roomDocs.get(rid)?.name;
			return !(name && params.name === name);
		};
		if (leaves(this.threadRid)) this.closeThread();
		if (leaves(this.panelRid)) this.closePanel();
	}

	/** The room Element's card panel (M9) is open in, else undefined. */
	private panelRid: string | undefined;
	/** Counts `openPanel` calls, as `threadSeq` does. */
	private panelSeq = 0;

	/**
	 * Element's own card (room info, members, files, pinned, search) in the host panel slot over the kit (M9, interim D39):
	 * `done` when the panel closes. The card is Element's, so the kit keeps no state but the room it is open in. A refused
	 * call leaves the panel that was already open as it was.
	 */
	public async openPanel(rid: string, card: ViewPanelCard): Promise<ActionOutcome> {
		if (typeof this.bridge.openPanel !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'a panel needs a host with openPanel');
		return this.inPanelSlot(rid, () => this.bridge.openPanel!(rid, card));
	}

	/**
	 * Element's own user info of a room member in the same host panel slot (M14 K4, interim D41; bridge version 8, feature-checked):
	 * the MXID and the DID row are Element's. Same lifecycle as `openPanel`; a host older than version 8 answers `unsupported`.
	 */
	public async openUserInfo(rid: string, userId: string): Promise<ActionOutcome> {
		if (typeof this.bridge.openUserInfo !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'a user info needs a host with openUserInfo');
		return this.inPanelSlot(rid, () => this.bridge.openUserInfo!(rid, userId));
	}

	/** Runs a host call that opens the panel slot: the kit remembers the room it is open in and restores the earlier one on a refusal. */
	private async inPanelSlot(rid: string, open: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
		const previous = this.panelRid;
		const seq = ++this.panelSeq;
		this.panelRid = rid;
		try {
			const out = await open();
			if (this.panelSeq === seq) this.panelRid = undefined; // `done`: the panel of this call closed
			return out;
		} catch (e) {
			if (this.panelSeq === seq) this.panelRid = previous;
			throw fromAction(e);
		}
	}

	/** Closes the card panel, if one is open (the kit left its room); a host with no panel has nothing to close. */
	public closePanel(): void {
		if (!this.panelRid) return;
		this.panelRid = undefined;
		if (typeof this.bridge.closePanel === 'function') this.bridge.closePanel();
	}

	/** Element asked, from a panel, to show an event of the panel's room: the callback gets Rocket.Chat's `_id` for it (F1). */
	public onJump(cb: (j: { roomId: string; id: string }) => void): () => void {
		if (typeof this.bridge.onJump !== 'function') return () => undefined;
		return this.bridge.onJump((j) => cb({ roomId: j.roomId, id: this.rcIds.get(j.eventId) ?? j.eventId }));
	}

	/** Element asked, from a panel, to show another room. */
	public onRoomOpen(cb: (j: { roomId: string; id?: string }) => void): () => void {
		if (typeof this.bridge.onRoomOpen !== 'function') return () => undefined;
		return this.bridge.onRoomOpen((j) =>
			cb(j.eventId ? { roomId: j.roomId, id: this.rcIds.get(j.eventId) ?? j.eventId } : { roomId: j.roomId }),
		);
	}

	/** Closes the thread panel, if one is open (the kit left its room). */
	public closeThread(): void {
		if (!this.threadRid) return;
		this.threadRid = undefined;
		if (typeof this.bridge.closeThread === 'function') this.bridge.closeThread();
	}

	/**
	 * Element's forward dialog over the kit. The outcome's `roomId` is the message's room, or the room the dialog's room-name
	 * jump went to (the caller follows to it); the kit keeps no state of its own.
	 */
	public async openForward(mid: string): Promise<ActionOutcome> {
		const known = this.message(mid);
		if (!known) throw new ReactError('unknown_event', 'error-message-not-found', 'Message not found');
		try {
			return await this.bridge.openForward(known.rid, this.eventIdOf(mid));
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** A bridge action of version 2 with room actions, its failure in Rocket.Chat's error shape. */
	private async roomAction<T>(name: 'join' | 'acceptInvite' | 'declineInvite' | 'createRoom' | 'createChat' | 'openDirectory' | 'startDm' | 'leave' | 'markUnread' | 'setFavourite' | 'setSection' | 'createSection' | 'editSection' | 'removeSection' | 'setNotificationLevel' | 'upload' | 'download' | 'showMedia' | 'logout', run: () => Promise<T>): Promise<T> {
		if (typeof this.bridge[name] !== 'function') throw Object.assign(new Error(`${name} needs bridge version 2 with room actions`), { code: 'unsupported' });
		try {
			return await run();
		} catch (e) {
			throw fromAction(e);
		}
	}

	/** Resolves when the room is among the kit's rooms (the bridge's room list follows an action a moment later), or false after `ms`. */
	public roomShown(rid: string, ms = 10_000): Promise<boolean> {
		if (this.roomDocs.has(rid)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (shown: boolean) => {
				off();
				clearTimeout(timer);
				resolve(shown);
			};
			const off = this.onChange((c) => {
				if (c.kind === 'room' && c.op === 'changed' && (c.doc as IRoom)._id === rid) finish(true);
			});
			const timer = setTimeout(() => finish(false), ms);
		});
	}

	/** Resolves when the room has left the kit's rooms (or after `ms`): a local chat is dropped once its real room exists. */
	public roomGone(rid: string, ms = 3_000): Promise<void> {
		if (!this.roomDocs.has(rid)) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				off();
				clearTimeout(timer);
				resolve();
			};
			const off = this.onChange((c) => {
				if (c.kind === 'room' && c.op === 'removed' && (c.doc as IRoom)._id === rid) finish();
			});
			const timer = setTimeout(finish, ms);
		});
	}

	/** The Rocket.Chat room by id, once the kit has it. */
	public room(rid: string): IRoom | undefined {
		return this.roomDocs.get(rid);
	}

	/**
	 * An outcome that created or joined a room: the kit has the room (to open it) before it is handed on. A `peek` outcome
	 * (a world-readable room Element only previews) is not in the room list and never will be: it is handed on at once.
	 */
	private async withRoom(outcome: ActionOutcome): Promise<ActionOutcome> {
		if (outcome.status === 'done' && outcome.roomId && !outcome.peek) await this.roomShown(outcome.roomId);
		return outcome;
	}

	/** A5: joins a room by id or `#alias:server` (the Join button of a room the user has not joined). */
	public join(roomIdOrAlias: string): Promise<ActionOutcome> {
		return this.roomAction('join', async () => this.withRoom(await this.bridge.join(roomIdOrAlias)));
	}

	/** A5: accepts the invite of a room. */
	public acceptInvite(rid: string): Promise<ActionOutcome> {
		return this.roomAction('acceptInvite', () => this.bridge.acceptInvite(rid));
	}

	/** A5: declines the invite of a room. */
	public declineInvite(rid: string): Promise<ActionOutcome> {
		return this.roomAction('declineInvite', () => this.bridge.declineInvite(rid));
	}

	/** A6: Element's create-room dialog (Rocket.Chat's "Create new" > Channel). */
	public createRoom(): Promise<ActionOutcome> {
		return this.roomAction('createRoom', async () => this.withRoom(await this.bridge.createRoom()));
	}

	/** A6: Element's start-chat dialog (Rocket.Chat's "Create new" > Direct message). */
	public createChat(): Promise<ActionOutcome> {
		return this.roomAction('createChat', async () => this.withRoom(await this.bridge.createChat()));
	}

	/**
	 * M10 W1 (bridge version 4, interim D41): Element's Spotlight over the view, from the navbar's Directory button.
	 * `done` + a room id: the room is among the kit's rooms (open it), or `peek` (previewed only); `cancelled`: closed with no pick.
	 * A host without the action (bridge version 2 | 3) rejects as `unsupported`.
	 */
	/** False on a host without `openDirectory` (bridge version 2 or 3): the search's server options are then not offered. */
	public canOpenDirectory(): boolean {
		return typeof this.bridge.openDirectory === 'function';
	}

	public openDirectory(opts?: { term?: string; filter?: 'rooms' | 'people' }): Promise<ActionOutcome> {
		return this.roomAction('openDirectory', async () => this.withRoom(await this.bridge.openDirectory(opts)));
	}

	/** False on a host without `startDm` (bridge before M11 Y4): "Reply directly" is then not offered on a message. */
	public canStartDm(): boolean {
		return typeof this.bridge.startDm === 'function';
	}

	/**
	 * M11 Y4 (interim D41): opens, or starts, the direct chat with `userId`. `done` + the DM's room id (among the kit's rooms once it is
	 * shown); `cancelled`: the user backed out. A host without the action rejects as `unsupported`; a host failure as `failed`.
	 * M12 Z2 F1: `fromRoomId` is the room of the message replied to (the host titles a new chat from that room's member).
	 */
	public startDm(userId: string, fromRoomId?: string): Promise<ActionOutcome> {
		return this.roomAction('startDm', async () => this.withRoom(await this.bridge.startDm!(userId, fromRoomId)));
	}

	/** A7: Element's leave confirm (Rocket.Chat's room menu "Leave"). */
	public leave(rid: string): Promise<ActionOutcome> {
		return this.roomAction('leave', () => this.bridge.leave(rid));
	}

	/** A10: the room menu's "Mark unread" (`/v1/subscriptions.unread`): the host writes the room's unread mark. */
	public markUnread(rid: string): Promise<ActionOutcome> {
		return this.roomAction('markUnread', () => this.bridge.markUnread(rid));
	}

	/** A10: the room menu's and the header's favourite star (`/v1/rooms.favorite`): the host sets or removes the room's favourite tag. */
	public setFavourite(rid: string, on: boolean): Promise<ActionOutcome> {
		return this.roomAction('setFavourite', () => this.bridge.setFavourite(rid, on));
	}

	/** M6 B1: the room's category (`/experimental/rooms.setCategory`): the host puts the room into the custom section, or takes it out (null). */
	public setSection(rid: string, tag: string | null): Promise<ActionOutcome> {
		return this.roomAction('setSection', () => this.bridge.setSection(rid, tag));
	}

	/** M6 B1: "New category": Element's own create-section dialog over the view (the room preselected when given). */
	public createSection(rid?: string): Promise<ActionOutcome> {
		return this.roomAction('createSection', () => this.bridge.createSection(rid));
	}

	/** M10 W2: the group menu's "Rename": Element's own section dialog in edit mode (the section tag is the category `_id`); `done` for a returned name, `cancelled` when closed first. */
	public editSection(tag: string): Promise<ActionOutcome> {
		return this.roomAction('editSection', () => this.bridge.editSection!(tag));
	}

	/** M10 W3: the group menu's "Delete": Element's own `RemoveSectionDialog`; `done` once the host's sections no longer list the tag, `cancelled` when declined. */
	public removeSection(tag: string): Promise<ActionOutcome> {
		return this.roomAction('removeSection', () => this.bridge.removeSection!(tag));
	}

	/** M11 Y3: whether the host can move a category (feature-check of `bridge.moveSection`); the group menu keeps Move up / Move down disabled without it. */
	public get canMoveSection(): boolean {
		return typeof this.bridge.moveSection === 'function';
	}

	/**
	 * M11 Y3: the group menu's "Move up" / "Move down": one step of Element's section reorder; `done` once the stored order and `sections()` show it.
	 * Not through `roomAction` (its action-name union is shared with other items). The host's error is rethrown as a `ReactError` with its code
	 * (`network` write refused, `failed` unknown tag / no neighbour / timeout) and its message read DUCK-TYPED: a host error comes from the other realm (N8).
	 */
	public async moveSection(tag: string, direction: 'up' | 'down'): Promise<ActionOutcome> {
		if (typeof this.bridge.moveSection !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'moveSection needs a host with category move');
		try {
			return await this.bridge.moveSection(tag, direction);
		} catch (e) {
			const code = (e as { code?: unknown } | null | undefined)?.code;
			const message = String((e as { message?: unknown } | null | undefined)?.message ?? e);
			throw new ReactError(typeof code === 'string' ? code : 'failed', `error-${typeof code === 'string' ? code : 'failed'}`, message);
		}
	}

	/** A10: the room's notification preferences (`/v1/rooms.saveNotification`), as one of Element's four levels. */
	public setNotificationLevel(rid: string, level: ViewNotificationLevel): Promise<ActionOutcome> {
		// Rocket.Chat's form has one "all" for both of Element's all-messages levels: a save that leaves the family (all) as it
		// is changes nothing, so a loud room is not downgraded by saving another field of the form.
		if (level === 'all_messages' && this.viewRooms.find((r) => r.id === rid)?.notificationLevel === 'all_messages_loud') {
			return Promise.resolve({ status: 'done', roomId: rid });
		}
		return this.roomAction('setNotificationLevel', () => this.bridge.setNotificationLevel(rid, level));
	}

	/** B7: a file attachment's download control or title: Element's Download button for the message (it decrypts and saves the file). */
	public download(rid: string, mid: string): Promise<ActionOutcome> {
		return this.roomAction('download', () => this.bridge.download(rid, this.eventIdOf(mid)));
	}

	/** True on a host that can reveal hidden media (bridge version 6, M12 Z3): the adapter marks a hidden image only then. */
	public get canShowMedia(): boolean {
		return typeof this.bridge.showMedia === 'function';
	}

	/**
	 * M12 Z3 (bridge version 6, interim D41): the Load box of a hidden image is Element's own Show / preview button for the message.
	 * Device-level in Element (no server write); the image arrives through the next timeline snapshot. A host without the action
	 * rejects as `unsupported`, a refusal is Rocket.Chat's error shape (the caller toasts it, the box stays).
	 */
	public showMedia(rid: string, mid: string): Promise<ActionOutcome> {
		return this.roomAction('showMedia', () => (this.bridge.showMedia as NonNullable<ClientViewBridge['showMedia']>)(rid, this.eventIdOf(mid)));
	}

	/**
	 * A8: Rocket.Chat's composer "Upload file" (no files): Element's own picker, confirmation and upload (the host's
	 * `RoomUploadViewModel`). B5: files dropped on the room or pasted into the composer (and the recorders' files) go in one call
	 * to the same flow, Element's own confirmation first.
	 */
	public upload(rid: string, files?: File[]): Promise<ActionOutcome> {
		return this.roomAction('upload', () => (files ? this.bridge.upload(rid, files) : this.bridge.upload(rid)));
	}

	/**
	 * A9: Rocket.Chat's "Log out" (user menu): Element's own sign-out (its `LogoutDialog`, the key backup check). `cancelled` when
	 * the dialog is dismissed. On success the host unmounts the kit with the session, so this normally never returns `done`.
	 */
	public logout(): Promise<ActionOutcome> {
		return this.roomAction('logout', () => this.bridge.logout());
	}

	/**
	 * M10 W4: Rocket.Chat's user menu "Profile": Element's settings dialog over the kit; `done` when it closes.
	 * M11 Y2 (bridge version 5): `opts.tab` picks the tab (Profile: account, Preferences, Accessibility: appearance, Feature preview: labs).
	 * The host's refusal (`labs` while Element lists no Labs tab) is its error, passed through (duck-typed, N8).
	 */
	public async openUserSettings(opts?: { tab?: ViewSettingsTab }): Promise<ActionOutcome> {
		if (typeof this.bridge.openUserSettings !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'opening the profile needs a host with openUserSettings');
		try {
			return await (opts ? this.bridge.openUserSettings(opts) : this.bridge.openUserSettings());
		} catch (e) {
			throw fromAction(e);
		}
	}

	/**
	 * M11 Y2 (D43): which settings tabs the user menu offers beyond Account. Preferences and Accessibility need a bridge version 5 host (a
	 * version 4 host would open the Account tab for them); Feature preview needs version 5 and `ViewMe.settingsLabsTab` (Element lists a Labs tab).
	 * Read fresh at each call; a flip of `settingsLabsTab` fires a `user` change (see `toUser`), so the menu re-renders.
	 */
	public settingsTabs(): { tabs: boolean; labs: boolean } {
		const v5 = typeof this.bridge.version === 'number' && this.bridge.version >= 5 && typeof this.bridge.openUserSettings === 'function';
		return { tabs: v5, labs: v5 && this.bridge.me().settingsLabsTab === true };
	}

	/**
	 * M10 W6: Rocket.Chat's Display menu sort radios (`activity`, `alphabetical`): the host sets the room list's sort the way Element's
	 * room list header does. `unread-first` has no radio in the kit, so any other option is `unsupported`; a host whose room list store is
	 * not ready answers `failed`.
	 */
	public async setRoomSort(option: 'recent' | 'alphabetical'): Promise<ActionOutcome> {
		if (option !== 'recent' && option !== 'alphabetical') throw new ReactError('unsupported', 'error-unsupported', `the kit offers no ${String(option)} sort`);
		if (typeof this.bridge.setRoomSort !== 'function') throw new ReactError('unsupported', 'error-unsupported', 'sorting the room list needs a host with setRoomSort');
		try {
			return await this.bridge.setRoomSort(option);
		} catch (e) {
			throw fromAction(e);
		}
	}

	public connection(): ViewConnection {
		return this.bridge.connection();
	}

	public views(): { id: string; name: string }[] {
		return this.bridge.views();
	}

	public switchTo(viewId: string): void {
		this.bridge.switchTo(viewId);
	}

	public onChange(cb: (c: Change) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	public onConnection(cb: (c: ViewConnection) => void): () => void {
		this.connListeners.add(cb);
		return () => this.connListeners.delete(cb);
	}

	/**
	 * Calls `cb` with the emoji name (`smile`) of each reaction the signed-in user newly has on a message the kit already
	 * showed (E0: Element's picker and a chip press never reach Rocket.Chat's own `addRecentEmoji`; the quick reactions
	 * on the hover toolbar follow from it).
	 */
	public onOwnReaction(cb: (name: string) => void): () => void {
		this.reactionListeners.add(cb);
		return () => this.reactionListeners.delete(cb);
	}

	private emit(c: Change): void {
		this.listeners.forEach((cb) => cb(c));
	}

	private syncMe(): void {
		const next = toUser(this.bridge.me(), this.viewSections);
		if (same(next, this.me)) return;
		this.me = next;
		this.emit({ kind: 'user', op: 'changed', doc: next });
	}

	private syncRooms(notify: boolean): void {
		const me = this.bridge.me();
		this.viewRooms = this.bridge.rooms();
		this.viewSections = this.bridge.sections?.();
		const names = slugs(this.viewRooms);
		const seen = new Set<string>();
		for (const r of this.viewRooms) {
			seen.add(r.id);
			const name = names.get(r.id)!;
			const room = toRoom(r, name, me, this.epoch);
			if (r.unreadCount > 0) this.readAt.delete(r.id);
			else if (!this.readAt.has(r.id)) this.readAt.set(r.id, Date.now());
			let sub = toSubscription(r, name, me, this.epoch, this.readAt.get(r.id));
			// Rocket.Chat's sidebar item re-renders only for a newer `_updatedAt`: a rename must be a later update than the one
			// before, and the later stamp stays while nothing else moves the subscription past it.
			const before = this.subDocs.get(r.id);
			let stamp = this.subStamps.get(r.id) ?? 0;
			if (before && (before.fname !== sub.fname || before.category !== sub.category)) stamp = Math.max(stamp, +before._updatedAt + 1);
			if (stamp > +sub._updatedAt) {
				this.subStamps.set(r.id, stamp);
				sub = { ...sub, _updatedAt: new Date(stamp) };
			}
			const renamed = this.roomDocs.get(r.id)?.name !== room.name;
			if (!same(room, this.roomDocs.get(r.id))) {
				this.roomDocs.set(r.id, room);
				if (notify) this.emit({ kind: 'room', op: 'changed', doc: room });
			}
			// Quote links carry the room's slug, so a rename re-links the room's loaded messages (grok kit F3).
			if (renamed && this.messages.has(r.id)) this.syncTimeline(r.id, notify);
			if (!same(sub, this.subDocs.get(r.id))) {
				this.subDocs.set(r.id, sub);
				if (notify) this.emit({ kind: 'subscription', op: 'changed', doc: sub });
			}
		}
		// M6 B1: the custom sections are the user's `sidebarCategories` preference (Rocket.Chat's own store of the user).
		const user = toUser(me, this.viewSections);
		if (!same(user, this.me)) {
			this.me = user;
			if (notify) this.emit({ kind: 'user', op: 'changed', doc: user });
		}
		for (const id of [...this.roomDocs.keys()]) {
			if (seen.has(id)) continue;
			const room = this.roomDocs.get(id)!;
			const sub = this.subDocs.get(id);
			this.roomDocs.delete(id);
			this.subDocs.delete(id);
			if (notify) {
				if (sub) this.emit({ kind: 'subscription', op: 'removed', doc: sub });
				this.emit({ kind: 'room', op: 'removed', doc: room });
			}
		}
	}

	/** The host answered a load: the held messages are history (kept for `historyBefore`) or live (streamed now). */
	private settleOlder(rid: string, ids?: Set<string>): void {
		const held = this.olderHeld.get(rid);
		this.olderHeld.delete(rid);
		for (const [id, entry] of held ?? []) {
			if (ids ? ids.has(id) : entry.history) {
				const pending = this.olderPending.get(rid) ?? new Set<string>();
				pending.add(entry.doc._id);
				this.olderPending.set(rid, pending);
			} else this.emit({ kind: 'message', op: 'changed', doc: entry.doc });
		}
	}

	/**
	 * Keeps a call's last view for `video-conference.info`. Rocket.Chat's card asks `info` once and re-asks only when the
	 * room's `videoconf` stream names the call (its server's push on every change), so a change of the call's state,
	 * participants or decline is announced the same way.
	 */
	private syncCall(m: ViewMessage, notify: boolean): void {
		const call = m.call!;
		const before = this.callViews.get(call.callId)?.call;
		if (call.state === 'ended' && !this.callEnds.has(call.callId)) this.callEnds.set(call.callId, before?.state === 'ongoing' ? Date.now() : call.startedTs);
		this.callViews.set(call.callId, m);
		for (const p of call.participants) if (p.avatarUrl) this.callAvatars.set(p.userId, p.avatarUrl);
		// `durationSeconds` ticks with the clock and the card shows none: it is no change.
		const shown = (c: typeof call | undefined) => c && JSON.stringify({ ...c, durationSeconds: undefined });
		if (notify && before && shown(before) !== shown(call)) this.emit({ kind: 'videoconf', op: 'changed', doc: { rid: m.roomId, callId: call.callId } });
	}

	private syncTimeline(rid: string, notify: boolean): void {
		const known = this.messages.get(rid) ?? new Map<string, IMessage>();
		this.messages.set(rid, known);
		// A message missing from the snapshot has left the timeline window, it was not deleted (a redaction arrives as a
		// changed tile), so messages are only ever added or changed here.
		// Rocket.Chat stores room messages on an async chain but handles a delete at once, so a row shown under the event id
		// and withdrawn in the same turn can leave a duplicate. While a send is in flight in this room the user's own new
		// rows that carry no transaction id are not shown: `adopt` shows them under the `_id`, or the sync after the send does.
		const holding = this.sendPending(rid);
		const timeline = this.bridge.timeline(rid);
		// While older messages load: what sits before the first message the kit knew then is history. With none known, all of it is.
		const prior = this.olderPrior.get(rid);
		let historyEnd = 0;
		if (prior) historyEnd = prior.size === 0 ? timeline.length : Math.max(0, timeline.findIndex((m) => prior.has(m.id)));
		for (const [index, m] of timeline.entries()) {
			const seen = this.lastViews.get(m.id);
			if (notify && seen && this.reactionListeners.size) {
				for (const name of newOwnReactionNames(seen, m)) this.reactionListeners.forEach((cb) => cb(name));
			}
			this.lastViews.set(m.id, m);
			if (m.redacted || (m.encryption && !encryptionLine(m.encryption))) {
				// A deleted message leaves the view as it does in Rocket.Chat (its delete notification); Element's redacted body
				// stays out. Once gone it is not shown again by a later read. An encryption entry with no Rocket.Chat line
				// (changed, disable_attempt, unsupported) is kept out the same way, also when it was an `enabled` line before.
				const gone = known.get(m.id);
				if (gone) {
					known.delete(m.id);
					this.rowAvatars.delete(m.id);
					if (notify) this.emit({ kind: 'message', op: 'removed', doc: gone });
				}
				continue;
			}
			if (m.call) this.syncCall(m, notify);
			if (m.senderId) this.senders.set(m.senderId, m);
			const pending = m.txnId ? this.pendingSends.get(m.txnId) : undefined;
			if (pending && !this.rcIds.has(m.id)) {
				this.rcIds.set(m.id, pending.rcId);
				this.eventIds.set(pending.rcId, m.id);
				// Shown under the event id before its transaction id was known: withdraw that row before the `_id` one.
				const early = known.get(m.id);
				if (early && early._id !== pending.rcId) {
					known.delete(m.id);
					this.olderHeld.get(rid)?.delete(m.id);
					if (notify) this.emit({ kind: 'message', op: 'removed', doc: early });
				}
			}
			if (holding && m.senderId === this.me._id && !this.rcIds.has(m.id) && !known.has(m.id)) continue;
			// A late echo of a send that failed with no echo, now shown: the homeserver held it, nothing is left to deduplicate
			// (a row still held back by another send in flight is not shown yet, so the retry still needs the id).
			if (!pending && m.txnId && this.failedSends.get(rid)?.txnId === m.txnId) this.failedSends.delete(rid);
			const rcId = this.rcIds.get(m.id);
			const doc = toMessage(rcId ? { ...m, id: rcId } : m, this.roomDocs.get(rid), (id) => this.rcIds.get(id) ?? id, { canShowMedia: this.canShowMedia });
			// The avatar is not part of the document, so a later avatar alone must re-render the row (grok kit F3).
			if (same(doc, known.get(m.id)) && this.rowAvatars.get(m.id) === m.senderAvatarUrl) continue;
			const isNew = !known.has(m.id);
			const held = this.olderHeld.get(rid)?.get(m.id);
			if (held) held.doc = doc;
			else if (prior && isNew) {
				// Seen while older messages load: history or live is known once the host answers.
				const heldIn = this.olderHeld.get(rid) ?? new Map<string, { doc: IMessage; history: boolean }>();
				heldIn.set(m.id, { doc, history: index < historyEnd });
				this.olderHeld.set(rid, heldIn);
			}
			known.set(m.id, doc);
			this.rowAvatars.set(m.id, m.senderAvatarUrl);
			if (notify && !(prior && (held || isNew))) this.emit({ kind: 'message', op: 'changed', doc });
		}
	}
}
