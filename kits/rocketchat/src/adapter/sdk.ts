// Replaces Rocket.Chat's `client/lib/SDKClient.ts` (the adapter seam, D7): answers the mapped endpoints, methods and
// streams from the bridge source and rejects + records everything else (H5). Nothing reaches a Rocket.Chat server.
import { location } from '../reload.ts';
import { getSource } from './bridge.ts';
import { settledPath } from '../composer-restore.ts';
import { HIDE_SETTINGS } from '../hide-actions.ts';
import { toCommonMark } from './format.ts';
import { CALL_PROVIDER, DISPLAY_NAME_SETTINGS, errorText, idHash, notificationLevelOf, parseQuotes, roomPath, shortcodesToUnicode, syncAnswer } from './map.ts';
import { answered, naError } from './recorder.ts';
import { type CachedName, type ComposerHolds, type RestoreComposer, type SaveDraft, wiring } from './wiring.ts';

// DDP (methods, streams) delivers EJSON-revived Date objects; REST delivers ISO strings. Keep both wire shapes.
const serialize = <T>(doc: T): T => structuredClone(doc);
const toJSON = <T>(doc: T): T => JSON.parse(JSON.stringify(doc));

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Set<Listener>>();
const emit = (key: string, ...args: unknown[]) => listeners.get(key)?.forEach((cb) => cb(...args));

// Where the kit opens a room after an action made or joined it (wired by bootstrap to Rocket.Chat's router).
export const setRoomOpener = (fn: (rid: string, replace?: boolean) => void) => {
	wiring.openRoom = fn;
};
const openRoom = (rid: string, replace?: boolean) => wiring.openRoom?.(rid, replace);

// Rooms the user looked up by address (`#alias:server`, the sidebar search): route name -> alias. The room is not joined,
// so Rocket.Chat opens its "not joined" screen from `getRoomByTypeAndName` and the Join button calls `rooms.join`.
// The route name carries a hash of the alias, so two addresses that slug alike (`#a:b.c`, `#a:b-c`) never share a route.
// Shared through wiring.ts (the bundler loads this module twice; room-opener's openPreview registers on the copy it imports).
const lookedUp = wiring.lookedUp;
// Alias -> the id of the room that joining it made (set by `rooms.join`): from then on the address leads to that room
// (search lists the real room, the address route redirects to it), never to the not-joined screen, while the user is in it.
const joinedAlias = new Map<string, string>();
const ALIAS_QUERY = /^[^\s:#]+:[^\s]+$/;
const aliasRouteName = (alias: string) => `${alias.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${idHash(alias)}`;
// The joined room of an address, while the kit still has it (a room left since is not joined any more).
const joinedRoom = (alias: string) => {
	const rid = joinedAlias.get(alias);
	const room = rid ? getSource().room(rid) : undefined;
	if (!room) joinedAlias.delete(alias);
	return room;
};
const aliasRoom = (alias: string) => {
	const name = aliasRouteName(alias);
	lookedUp.set(name, alias);
	return { _id: alias, t: 'c', name, fname: alias, msgs: 0, usersCount: 0, ts: new Date(0), _updatedAt: new Date() };
};

/** A room the user only previews (the Directory's `peek`): registered like a looked-up address, so its route opens the not-joined screen. */
export const openPreview = (roomId: string): { rid: string; name: string } => {
	const { _id, name } = aliasRoom(roomId);
	return { rid: _id, name };
};

let wired = false;
const wireSource = () => {
	if (wired) return;
	wired = true;
	const src = getSource();
	src.onChange(({ kind, op, doc }) => {
		const uid = src.me._id;
		// Rocket.Chat's server tells a call card to ask `video-conference.info` again with this notification (`useVideoConfDataStream`).
		if (kind === 'videoconf') {
			const { rid, callId } = doc as { rid: string; callId: string };
			emit(`notify-room:${rid}/videoconf`, callId);
			return;
		}
		if (kind === 'message' && op === 'changed') emit(`room-messages:${(doc as { rid: string }).rid}`, serialize(doc));
		// A row withdrawn because the user's own send was confirmed under another id: Rocket.Chat's delete notification.
		if (kind === 'message' && op === 'removed') emit(`notify-room:${(doc as { rid: string }).rid}/deleteMessage`, { _id: (doc as { _id: string })._id });
		if (kind === 'subscription') emit(`notify-user:${uid}/subscriptions-changed`, op, serialize(doc));
		if (kind === 'room') emit(`notify-user:${uid}/rooms-changed`, op, serialize(doc));
		// M6 B1: the user's preferences (the categories) change in Rocket.Chat's own user store, the way its userData stream does.
		// M10 W4: so does the display name (`toUser` maps nothing else that changes: `_id` and `username` are the Matrix id), or the
		// profile's rename never reaches the user menu and the avatar fallback.
		if (kind === 'user') {
			const { settings, name } = doc as { settings?: { preferences?: Record<string, unknown> }; name?: string };
			emit(`notify-user:${uid}/userData`, { type: 'updated', id: uid, diff: { ...(name !== undefined ? { name } : {}), 'settings.preferences': serialize(settings?.preferences ?? {}) }, unset: {} });
		}
	});
};

// The ids Rocket.Chat's Rooms/Subscriptions stores hold (wired by bootstrap): a `since` sync removes the ones the bridge
// snapshot lacks (a room left while the page was offline or cached). Unwired is an error, never an empty answer.
export const setCachedIds = (name: CachedName, ids: () => Iterable<string>) => {
	wiring.cachedIds[name] = ids;
};
const cachedIds = (name: CachedName): Iterable<string> => {
	const ids = wiring.cachedIds[name];
	if (!ids) throw new Error(`cached ids for ${name} not wired`);
	return ids();
};

// `delete-own-message` lets the user delete their own messages (A12); editing one's own needs no permission. `pin-message` is
// granted to every role: whether Pin / Unpin is offered on a message is Element's rule (`ViewMessage.canPin`, the swapped pin
// actions read it), a per-room permission could not say it. Deleting or
// editing another user's message (`delete-message`, `edit-message`) is not granted: the host refuses it too.
const BASE_PERMISSIONS = ['view-c-room', 'view-joined-room', 'view-d-room', 'view-p-room', 'start-discussion', 'create-c', 'create-p', 'create-d', 'delete-own-message', 'pin-message', 'leave-c', 'leave-p'];
const SETTINGS: Record<string, unknown> = {
	Site_Name: 'Element',
	// REQ-0008 V2: Rocket.Chat's /home cards (shown when no room is open) name the product in three strings. RC applies this
	// setting (a JSON string: language -> key -> text) over its bundled English, so the text is neutral, no product name.
	Custom_Translations: JSON.stringify({
		en: {
			Take_rocket_chat_with_you_with_mobile_applications: 'Take your chats with you with the mobile apps.',
			Install_rocket_chat_on_your_preferred_desktop_platform: 'Install the desktop app on your preferred platform.',
			Learn_how_to_unlock_the_myriad_possibilities_of_rocket_chat: 'Learn what you can do here.',
		},
	}),
	Language: 'en',
	...DISPLAY_NAME_SETTINGS,
	// D41: Rocket.Chat's own `Katex_Enabled` false drops the KaTeX formatter button.
	...HIDE_SETTINGS,
	// Rocket.Chat's link previews render only with this on; whether a message has any is Element's view-model's call.
	API_Embed: true,
	Message_GroupingPeriod: 300,
	// The composer's too-long check compares against it (unset, every message counts as too long); Rocket.Chat's default.
	// A longer text is refused with a toast: no conversion to a file attachment (that is an upload).
	Message_MaxAllowedSize: 5000,
	Message_AllowConvertLongMessagesToAttachment: false,
	// Editing and deleting one's own messages, without a time limit (the homeserver has none either).
	Message_AllowEditing: true,
	Message_AllowEditing_BlockEditInMinutes: 0,
	Message_AllowDeleting: true,
	Message_AllowDeleting_BlockDeleteInMinutes: 0,
	// The message menu's Pin / Unpin items (B2).
	Message_AllowPinning: true,
	// The room menu's "Favorite" item and the header star are offered (A10).
	Favorite_Rooms: true,
	Message_TimeFormat: 'LT',
	Message_DateFormat: 'LL',
	Accounts_AllowAnonymousRead: false,
	// B3: the composer's emoji picker is off unless the preference is on (Rocket.Chat's default is on).
	Accounts_Default_User_Preferences_useEmojis: true,
	// Enter sends, Shift+Enter breaks the line (unset, the composer reads the preference as 'off' and Enter only breaks the line).
	Accounts_Default_User_Preferences_sendOnEnter: 'normal',
	Accounts_Default_User_Preferences_sidebarViewMode: 'medium',
	Accounts_Default_User_Preferences_sidebarDisplayAvatar: true,
	Accounts_Default_User_Preferences_sidebarGroupByType: true,
	Accounts_Default_User_Preferences_sidebarShowUnread: true,
	Accounts_Default_User_Preferences_sidebarSortby: 'activity',
	Accounts_Default_User_Preferences_displayAvatars: true,
	E2E_Enable: false,
	Livechat_enabled: false,
	Threads_enabled: false,
	Discussion_enabled: false,
	// OAuth providers are N/A; their hooks need string URLs to stay idle.
	API_Drupal_URL: '',
	API_GitHub_Enterprise_URL: '',
	API_Gitlab_URL: '',
	API_Wordpress_URL: '',
	Accounts_OAuth_Dolphin_URL: '',
	Accounts_OAuth_Nextcloud_URL: '',
};

// Calls (lane CALL): on only when the host config names the call app's address (C5: absent = no provider, no header call
// button, no permission). Rocket.Chat's own defaults for the four room-type switches are on, so off is said explicitly.
const callSettings = (on: boolean): Record<string, unknown> => ({
	VideoConf_Default_Provider: on ? CALL_PROVIDER : '',
	VideoConf_Enable_DMs: on,
	VideoConf_Enable_Channels: on,
	VideoConf_Enable_Groups: on,
	VideoConf_Enable_Teams: on,
});
const allSettings = () => ({ ...SETTINGS, ...callSettings(!!getSource().meetUrl()) });
const permissions = () => (getSource().meetUrl() ? [...BASE_PERMISSIONS, 'call-management'] : BASE_PERMISSIONS);

const methods: Record<string, (...args: unknown[]) => unknown> = {
	'rooms/get': (since) => {
		const docs = serialize(getSource().rooms());
		return since ? syncAnswer(docs, cachedIds('rooms')) : docs;
	},
	'subscriptions/get': (since) => {
		const docs = serialize(getSource().subscriptions());
		return since ? syncAnswer(docs, cachedIds('subscriptions')) : docs;
	},
	'public-settings/get': () => Object.entries(allSettings()).map(([_id, value]) => ({ _id, value, public: true })),
	'private-settings/get': () => [],
	// The unjoined room of an address lookup (see `lookedUp`); every other room is known to the stores already.
	getRoomByTypeAndName: (type, name) => {
		const alias = type === 'c' ? lookedUp.get(String(name)) : undefined;
		if (!alias) throw naError('call', 'getRoomByTypeAndName');
		// Joined since: this address route (Back, a reload) moves on to the real room, replacing itself in the history.
		const joined = joinedRoom(alias);
		if (joined) {
			setTimeout(() => openRoom(joined._id, true), 0);
			return toJSON(joined);
		}
		return toJSON(aliasRoom(alias));
	},
	'permissions/get': () => permissions().map((_id) => ({ _id, roles: ['user'], _updatedAt: new Date() })),
};

// How many history asks Rocket.Chat made and how they ended, on `window.__clientViewHistory` for specs (like the stub log).
const historyCount = () => {
	const w = window as unknown as { __clientViewHistory?: { asked: number; answered: number; failed: number } };
	return (w.__clientViewHistory ??= { asked: 0, answered: 0, failed: 0 });
};

/** True when `?msg` of the (virtual) location names this message id (the id is encoded for Rocket.Chat's double decode, see `jumpParam`). */
export const isJumpTarget = (msgId: string): boolean => {
	try {
		const raw = new URLSearchParams(location.search).get('msg');
		return raw !== null && decodeURIComponent(raw) === msgId;
	} catch {
		return false;
	}
};

/**
 * True when the route shows this room: its room path (settled, as Rocket.Chat's router encodes a direct id twice) followed by
 * nothing or by a tab and a context segment (`/<tab>[/<context>]`), so a room open on its Threads tab still counts.
 */
export const routeShowsRoom = (room: NonNullable<Parameters<typeof roomPath>[0]>, pathname: string): boolean => {
	const base = settledPath(roomPath(room));
	const cur = settledPath(pathname);
	if (cur === base) return true;
	if (!cur.startsWith(`${base}/`)) return false;
	const rest = cur.slice(base.length + 1).split('/');
	return rest.length <= 2 && rest.every((seg) => seg !== '');
};

const getEndpoints: Record<string, (params: Record<string, unknown>) => unknown> = {
	// Rocket.Chat's history page: newest first. The cursor is how it asks for older messages (see `historyBefore`).
	'/v1/rooms.history': async ({ roomId, previous, aroundId }) => {
		const count = historyCount();
		count.asked++;
		try {
			// A jump (`?msg=`, F1): the message is in the window by now (`chat.getMessage` paged it in), so the answer is the live
			// window with nothing newer to page (`cursor.next: null`); Rocket.Chat would otherwise think a newer side exists.
			if (typeof aroundId === 'string' && aroundId) {
				const around = getSource().windowAround(String(roomId));
				count.answered++;
				return { messages: toJSON(around.messages).reverse(), cursor: { previous: around.previous, next: null }, unreadNotLoaded: 0, success: true };
			}
			const page = await getSource().historyBefore(String(roomId), typeof previous === 'string' ? previous : undefined);
			count.answered++;
			return { messages: toJSON(page.messages).reverse(), cursor: { previous: page.previous }, unreadNotLoaded: 0, success: true };
		} catch (e) {
			count.failed++;
			throw rcError(e);
		}
	},
	'/v1/chat.getMessage': async ({ msgId }) => {
		const source = getSource();
		let message = source.message(String(msgId));
		if (!message) {
			// Not loaded yet (a quote of an older message): page older history in until it is, the room starts or the window ends.
			const room = source.rooms().find((r) => routeShowsRoom(r, location.pathname));
			if (room) {
				try {
					message = await source.ensureMessage(room._id, String(msgId));
				} catch (e) {
					// A failed page-back is the jump's failure too: Rocket.Chat clears `?msg` without a word, so toast it as the not-found path does.
					const err = rcError(e);
					if (isJumpTarget(String(msgId))) wiring.jumpFailed?.(err.message);
					throw err;
				}
			}
		}
		// LIMIT: beyond the host's loadable window (or the room's start) the message does not come. Rocket.Chat clears `?msg` without a
		// word here, so the kit toasts it (wiring.jumpFailed) when this fetch is the jump's own (`?msg` names the id).
		if (!message) {
			const err = rcError(Object.assign(new Error('The quoted message is not in the history this view can load'), { code: 'message-not-loaded' }));
			if (isJumpTarget(String(msgId))) wiring.jumpFailed?.(err.message);
			throw err;
		}
		return { message: toJSON(message), success: true };
	},
	// The call provider (lane CALL): the call runs in the call app's own window. No `mic`/`cam` capability on purpose: Rocket.Chat's
	// "Start a call" popup draws a microphone and a camera toggle only for a provider that offers them (StartCallPopup `showMic` /
	// `showCam`), and aqua-meet's room link takes no device choice, so a toggle would be one the call ignores. A device choice
	// needs the meet track (the room link has no input for it); no adapter workaround (e.g. a query parameter) stands in.
	'/v1/video-conference.capabilities': () => {
		callAppUrl();
		return { providerName: CALL_PROVIDER, capabilities: {}, success: true };
	},
	// The call card's data (`useVideoConferenceInfo`): the call the bridge handed over, as Rocket.Chat's `VideoConference`.
	'/v1/video-conference.info': ({ callId }) => {
		const call = getSource().videoConference(String(callId));
		if (!call) throw rcError(Object.assign(new Error('invalid-params'), { code: 'invalid-params' }));
		return toJSON(call);
	},
	'/v1/chat.syncMessages': () => ({ result: { updated: [], deleted: [] }, success: true }),
	'/v1/me': () => ({ ...toJSON(getSource().me), success: true }),
	'/v1/users.info': ({ userId, username }) => {
		const user = getSource().user(String(userId ?? username));
		if (!user) throw naError('rest.get', '/v1/users.info (unknown user)');
		return { user: toJSON(user), success: true };
	},
	// An exact `#alias:server` search (channels only) lists the one room to join. Any other lookup (the sidebar search's, for rooms
	// and users) is answered with empty server lists: the kit has no search of ours (D1, D38), the sidebar's two "Search the
	// server" options hand the term to Element's own Spotlight (M10 W5, src/navbar-search-listbox.tsx, row search-server).
	// M7 E2: the composer's `@` popup (`users` + `mentions`, in a room) lists the members Element's own autocomplete offers.
	'/v1/spotlight': async ({ query, type, rid }) => {
		let kind: { users?: boolean; rooms?: boolean; mentions?: boolean } = {};
		try {
			kind = JSON.parse(String(type ?? '{}'));
		} catch {
			// an unreadable type is no address search
		}
		const q = String(query ?? '');
		if (kind.users === true && kind.mentions === true && typeof rid === 'string' && rid) {
			try {
				const found = await getSource().mentionCandidates(rid, q);
				return { users: found.map((u) => ({ _id: u.userId, username: u.userId, name: u.displayName, status: 'online' })), rooms: [], success: true };
			} catch (e) {
				throw rcError(e);
			}
		}
		if (kind.users !== false || kind.rooms !== true || !ALIAS_QUERY.test(q)) return { users: [], rooms: [], success: true };
		const alias = `#${q}`;
		// An address already joined is its real room.
		const joined = joinedRoom(alias);
		// The row has to survive the sidebar search's own filter (it matches the typed address against `name` and `fname`): the
		// real room (its id, its route name) shown under the address. The room's own title would not match the address.
		return { users: [], rooms: [joined ? { ...toJSON(joined), fname: alias } : toJSON(aliasRoom(alias))], success: true };
	},
	// Login stays stock Element: Rocket.Chat has no login services to offer (honest empty, not a rejection).
	'/v1/service.configurations': () => ({ configurations: [], success: true }),
	// B3: Matrix has no custom emoji; the composer's picker lists the Unicode set it bundles.
	'/v1/emoji-custom.list': () => ({ emojis: { update: [], remove: [] }, success: true }),
};

// Rocket.Chat's error shape (errorHandling.getErrorMessage reads `error`; the toast shows it).
const rcError = (e: unknown): Error => {
	const message = errorText(e);
	const code = (e as { code?: string } | undefined)?.code ?? 'failed';
	return Object.assign(new Error(message), { success: false, error: message, errorType: `error-${code}` });
};

// Puts the text of a rejected send back into the room's composer (wired by bootstrap: it touches the page). Rocket.Chat
// clears the composer before it posts, so a rejection would otherwise delete the only copy of what the user typed (D21).
// The toast of a jump to a message that does not come (wired by bootstrap: it touches the page). Rocket.Chat only clears
// `?msg` silently when `chat.getMessage` fails, so without this the click would do nothing the user can see.
export const setJumpFailed = (fn: (message: string) => void) => {
	wiring.jumpFailed = fn;
};

export const setRestoreComposer = (fn: RestoreComposer) => {
	wiring.restoreComposer = fn;
};

// Puts a rejected send's text back where it was typed; true when it reached a composer. A composer that cannot be reached loses nothing more (the toast carries the error).
const restoreNow = (rid: string, text: string): boolean => {
	try {
		return !!wiring.restoreComposer && wiring.restoreComposer(rid, text) !== false;
	} catch {
		return false;
	}
};

/** Where the text survives when no composer kept it: Rocket.Chat's own draft of the room (shown when its composer mounts). */
export const setComposerKeeper = (holds: ComposerHolds, saveDraft: SaveDraft) => {
	wiring.composerHolds = holds;
	wiring.saveDraft = saveDraft;
};

const keepDraft = (rid: string, text: string) => {
	try {
		wiring.saveDraft?.(rid, text);
	} catch {
		// the toast carries the error
	}
};

// D1: the real room's composer exists only after the route has left the local room and the room view has mounted, so the draft
// goes back by trying the restore (it refuses until the route is on that room and its textarea exists) for a few seconds. A
// restore counts as done only when, a moment later, the textarea on screen for that room still holds the text: the route moves
// before the view does, so the first write can land in the previous view's composer, which is then unmounted (grok track F1).
// A throw is one more try. Resolves false when no lasting restore was confirmed in the window.
const restoreWhenOpen = async (rid: string, text: string): Promise<boolean> => {
	const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
	for (let tries = 0; tries < 30 && text.trim(); tries++) {
		const wrote = restoreNow(rid, text);
		await pause();
		if (!wrote) continue;
		const holds = wiring.composerHolds;
		try {
			if (!holds || holds(rid, text)) return true;
		} catch {
			// not confirmed: another try
		}
	}
	return false;
};

// A new chat's first message made the real room: open it in place of the local one (the move of a send that worked and of a
// failed first send alike). Resolves false when the room is not shown (nothing moved). `draft` is put back in the real room;
// when no composer there keeps it, it goes into Rocket.Chat's draft of the real room (never into the local room, which left the list).
const followCreated = async (local: string, real: string, draft?: string): Promise<boolean> => {
	const src = getSource();
	if (!(await src.roomShown(real))) return false;
	// Rocket.Chat sends the user home when the room it shows is removed, so the local room goes first.
	await src.roomGone(local);
	src.moveOffered(local, real);
	// Rocket.Chat reacts to the removal on its own async chain: let it send the user home first.
	await new Promise((resolve) => setTimeout(resolve, 600));
	openRoom(real);
	if (draft !== undefined && !(await restoreWhenOpen(real, draft).catch(() => false))) keepDraft(real, draft);
	return true;
};

// The composer's send: plain text to the host's interim send, with Rocket.Chat's own `_id` as the transaction id. A quote
// at the start of the text (Rocket.Chat's Quote action) is the reply: the quoted message's id goes as `replyTo`, its
// permalink is not part of the text. Matrix replies to one message: further quotes are dropped.
const sendMessage = async (body: Record<string, unknown>) => {
	const message = (body.message ?? {}) as { _id?: string; rid?: string; msg?: string; tmid?: string; attachments?: unknown[] };
	if (!message._id || !message.rid || typeof message.msg !== 'string') throw rcError(new Error('error-invalid-message'));
	if (message.tmid || message.attachments?.length) throw naError('rest.post', '/v1/chat.sendMessage (thread, quote or attachment)');
	const { text, quoted } = parseQuotes(message.msg);
	try {
		// B3: `:smile:` goes out as the Unicode emoji; a refused send restores the draft as typed. E1: Rocket.Chat's markup
		// goes out as the CommonMark Element's composer sends (`toCommonMark`).
		const outcome = await getSource().sendText(message.rid, toCommonMark(shortcodesToUnicode(text)), message._id, quoted[0]);
		// The first message of a new chat made the real room: open it in place of the local one.
		if (outcome.status === 'done' && outcome.roomId && outcome.roomId !== message.rid) void followCreated(message.rid, outcome.roomId).catch(() => false);
	} catch (e) {
		// M13 U3: the room was made and only the send failed (the host's error names the room, additive `roomId`): the user
		// goes to the real room as after a send that worked (stock Element views it too), and the draft is put back THERE once
		// its composer is on screen. Without the field, or when the room is not shown, the draft goes back where it was typed.
		const real = (e as { roomId?: unknown } | null)?.roomId;
		if (typeof real === 'string' && real !== message.rid) {
			void followCreated(message.rid, real, text).catch(() => false).then((shown) => {
				// Not moved: the local composer when it is still on screen (its room still listed), else where the text survives. The host
				// drops a created local room from the list before this rejection arrives, so that composer is usually gone.
				if (!shown && !restoreNow(message.rid, text)) keepDraft(real, text);
			});
		} else restoreNow(message.rid, text);
		throw rcError(e);
	}
	answered('POST /v1/chat.sendMessage');
	return { message: toJSON({ ...message, ts: new Date() }), success: true };
};

// The call app's address, or Rocket.Chat's own "no provider" error (no call is possible without one).
const callAppUrl = (): string => {
	const url = getSource().meetUrl();
	if (!url) throw rcError(Object.assign(new Error('error-no-video-conf-provider'), { code: 'no-video-conf-provider' }));
	return url;
};

// `video-conference.start`: the call the bridge shows running in the room (never a second one), else a fresh id bound to the
// room; the call itself starts in the call app, whose room link opens the Matrix call. A group conference also in a DM (no ringing).
const startCall = (body: Record<string, unknown>) => {
	callAppUrl();
	const rid = body.roomId;
	if (typeof rid !== 'string' || !rid) throw rcError(Object.assign(new Error('error-invalid-params'), { code: 'invalid-params' }));
	const src = getSource();
	const callId = src.ongoingCall(rid) ?? `call-${rid}-${Date.now().toString(36)}`;
	src.bindCall(callId, rid);
	return { data: { type: 'videoconference', callId, rid, providerName: CALL_PROVIDER }, success: true };
};

// `video-conference.join`: the call app's link to the call's room (the room id URL-encoded, as the app's room link reads it).
const joinCall = (body: Record<string, unknown>) => {
	const base = callAppUrl();
	const room = typeof body.callId === 'string' ? getSource().callRoom(body.callId) : undefined;
	if (!room || room.ended) throw rcError(Object.assign(new Error(room ? 'error-videoconf-ended' : 'error-invalid-params'), { code: room ? 'videoconf-ended' : 'invalid-params' }));
	return { url: `${base}/#/room/${encodeURIComponent(room.rid)}`, providerName: CALL_PROVIDER, success: true };
};

const rest = {
	get: async (path: string, params: Record<string, unknown> = {}) => {
		const fn = getEndpoints[path];
		if (!fn) throw naError('rest.get', path);
		answered(`GET ${path}`);
		return fn(params);
	},
	post: async (path: string, body: Record<string, unknown> = {}) => {
		// Rocket.Chat's read marker maps to the host's read path (an Element read receipt through a view-model).
		if (path === '/v1/subscriptions.read') {
			getSource().markRead(String(body.rid));
			answered(`POST ${path}`);
			return { success: true };
		}
		if (path === '/v1/chat.sendMessage') return sendMessage(body);
		// Rocket.Chat's message edit (A11): the host's interim replacement send, for the user's own message.
		if (path === '/v1/chat.update') {
			const { msgId, text: raw } = body as { msgId?: string; text?: unknown };
			if (typeof msgId !== 'string' || typeof raw !== 'string') throw rcError(new Error('error-invalid-params'));
			// The composer prefixes the Quote chips' permalinks to an edit as well (one payload for send and edit); an edit
			// cannot change the reply relation, so the quote is dropped and the body is what remains.
			// B3: a typed shortcode goes out as Unicode on an edit as well; the failure path is A11's.
			const text = shortcodesToUnicode(parseQuotes(raw).text);
			await getSource().editText(msgId, toCommonMark(text));
			answered(`POST ${path}`);
			return { message: toJSON({ _id: msgId, rid: String(body.roomId ?? ''), msg: text, _updatedAt: new Date() }), success: true };
		}
		// Rocket.Chat's message delete (A12), after its own confirmation: the host's interim redaction.
		if (path === '/v1/chat.delete') {
			const { msgId } = body as { msgId?: string };
			if (typeof msgId !== 'string') throw rcError(new Error('error-invalid-params'));
			await getSource().deleteMessage(msgId);
			answered(`POST ${path}`);
			return { _id: msgId, ts: Date.now(), message: toJSON({ _id: msgId, rid: String(body.roomId ?? '') }), success: true };
		}
		// Rocket.Chat's pin and unpin (after its own confirmation for a pin): the host's pin action. Its pinned list view
		// (`chat.getPinnedMessages`) stays unanswered.
		if (path === '/v1/chat.pinMessage' || path === '/v1/chat.unPinMessage') {
			const { messageId } = body as { messageId?: string };
			if (typeof messageId !== 'string') throw rcError(new Error('error-invalid-params'));
			await getSource().setPinned(messageId, path === '/v1/chat.pinMessage');
			answered(`POST ${path}`);
			return { message: toJSON({ _id: messageId }), success: true };
		}
		// Rocket.Chat's reaction toggle (a chip, a quick reaction or a picked emoji): the host's reactions row button.
		if (path === '/v1/chat.react') {
			const name = String(body.emoji ?? body.reaction ?? '');
			await getSource().react(String(body.messageId), name);
			answered(`POST ${path}`);
			return { success: true };
		}
		// A5: the Join button of a room the user has not joined (an address lookup), then its room opens.
		if (path === '/v1/rooms.join') {
			try {
				const target = String(body.roomId ?? '');
				const outcome = await getSource().join(target);
				if (outcome.status === 'done' && outcome.roomId) {
					if (outcome.roomId !== target) joinedAlias.set(target, outcome.roomId);
					// Replacing the address route: Back goes to the page before the address, not to a stale not-joined entry.
					openRoom(outcome.roomId, true);
				}
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		// A5: an invite's Accept / Reject (Rocket.Chat asks to confirm the rejection itself: Element has no dialog for it).
		if (path === '/v1/rooms.invite') {
			try {
				if (body.action === 'accept') await getSource().acceptInvite(String(body.roomId));
				else if (body.action === 'reject') await getSource().declineInvite(String(body.roomId));
				else throw rcError(new Error('error-invalid-params'));
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		// A10: the room menu's Mark unread (the whole room; "from this message" has no Matrix counterpart), the favourite star and
		// the notification preferences. Each is answered by the host's room item action; a refusal is Rocket.Chat's error toast.
		if (path === '/v1/subscriptions.unread') {
			if (typeof body.roomId !== 'string') throw naError('rest.post', '/v1/subscriptions.unread (from a message)');
			try {
				await getSource().markUnread(body.roomId);
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		if (path === '/v1/rooms.favorite') {
			if (typeof body.roomId !== 'string' || typeof body.favorite !== 'boolean') throw rcError(new Error('error-invalid-params'));
			try {
				await getSource().setFavourite(body.roomId, body.favorite);
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		// M6 B1: the room menu's and the header's "Move to" / "Remove from" (the user's category of a room): the host puts the rooms
		// into the custom section, or takes them out of theirs (`category: null`). Rocket.Chat's server checks a licence here; the
		// bridge does not, the sidebar and header sites are ungated in the build instead (patch class "ungate category").
		if (path === '/experimental/rooms.setCategory') {
			const { roomIds, category } = body as { roomIds?: unknown; category?: unknown };
			if (!Array.isArray(roomIds) || roomIds.length === 0 || !roomIds.every((id) => typeof id === 'string') || !(category === null || typeof category === 'string'))
				throw rcError(new Error('error-invalid-params'));
			try {
				for (const rid of roomIds as string[]) await getSource().setSection(rid, category as string | null);
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		// Lane CALL: start and join are answered above; the call's truth is Matrix, so cancel, leave and heartbeat have nothing to
		// record. Decline, ring, list, rename and the rest stay rejected and logged.
		if (path === '/v1/video-conference.start') {
			answered(`POST ${path}`);
			return startCall(body);
		}
		if (path === '/v1/video-conference.join') {
			const out = joinCall(body);
			answered(`POST ${path}`);
			return out;
		}
		if (path === '/v1/video-conference.cancel' || path === '/v1/video-conference.leave' || path === '/v1/video-conference.heartbeat') {
			answered(`POST ${path}`);
			return { success: true };
		}
		if (path === '/v1/rooms.saveNotification') {
			const notifications = body.notifications;
			if (typeof body.roomId !== 'string' || typeof notifications !== 'object' || notifications === null) throw rcError(new Error('error-invalid-params'));
			try {
				await getSource().setNotificationLevel(body.roomId, notificationLevelOf(notifications as Record<string, unknown>));
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		// M10 W6: the Display menu's Sort by radios save `sidebarSortby`; the host sets Element's room list sort (the `me` event
		// then carries it back as the preference). Any other preference key or value stays rejected and logged.
		if (path === '/v1/users.setPreferences') {
			const data = body.data;
			const keys = typeof data === 'object' && data !== null ? Object.keys(data) : [];
			const sortby = keys.length === 1 && keys[0] === 'sidebarSortby' ? (data as Record<string, unknown>).sidebarSortby : undefined;
			if (sortby !== 'activity' && sortby !== 'alphabetical') throw naError('rest.post', path);
			try {
				await getSource().setRoomSort(sortby === 'activity' ? 'recent' : 'alphabetical');
			} catch (e) {
				throw rcError(e);
			}
			answered(`POST ${path}`);
			return { success: true };
		}
		throw naError('rest.post', path);
	},
	put: async (path: string) => {
		throw naError('rest.put', path);
	},
	delete: async (path: string) => {
		throw naError('rest.delete', path);
	},
	upload: (path: string) => {
		throw naError('rest.upload', path);
	},
	getCredentials: () => undefined,
};

const call = async (method: string, ...args: unknown[]) => {
	const fn = methods[method];
	if (!fn) throw naError('call', method);
	answered(`call ${method}`);
	return fn(...args);
};

const stream = (name: string, keys: unknown[], cb: Listener) => {
	wireSource();
	const key = `${name}:${String(keys[0])}`;
	if (!listeners.has(key)) listeners.set(key, new Set());
	listeners.get(key)!.add(cb);
	const handle = {
		stop: () => listeners.get(key)?.delete(cb),
		ready: () => Promise.resolve(),
		isReady: true,
		onReady: (fn: () => void) => fn(),
		onChange: () => () => undefined,
	};
	return handle;
};

export const createSDK = () => ({
	rest,
	stop: () => undefined,
	stream,
	onAnyStreamEvent: (name: string) => ({ stop: () => undefined, name }),
	publish: (name: string) => {
		naError('publish', name);
	},
	call,
	connection: {
		get status() {
			return getSource().connection() === 'online' ? 'connected' : 'connecting';
		},
		on: (_event: string, cb: () => void) => getSource().onConnection(cb),
	},
});

export const sdk = createSDK();
