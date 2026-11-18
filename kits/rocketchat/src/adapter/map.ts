// Bridge data -> Rocket.Chat documents. Pure functions, no window and no Rocket.Chat runtime, so node:test runs them.
import type { IMessage, IRoom, ISubscription, IUser } from '@rocket.chat/core-typings';

import type { ViewCall, ViewE2e, ViewEncryption, ViewMe, ViewMedia, ViewMessage, ViewNotificationLevel, ViewRoom, ViewSection } from '../bridge-types.ts';
import { fromCommonMark } from './format.ts';

/**
 * Rocket.Chat's own setting that makes channel and group names show `fname` (the display name) instead of `name`
 * (the route slug); `UI_Use_Real_Name` does the same for direct messages and senders.
 */
export const DISPLAY_NAME_SETTINGS = { UI_Allow_room_names_with_special_chars: true, UI_Use_Real_Name: true } as const;

/** A route-safe slug for Rocket.Chat's `name` (used in /channel/<name>); the display name goes to `fname`. */
export const slug = (name: string): string =>
	name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'room';

/**
 * The text of a failure, duck-typed: the kit runs in an iframe and the host's failure is an error object of the HOST window's realm,
 * so `instanceof Error` is false here and would print `ClientViewActionError: <message>` through String(). M11 Y1.
 */
export const errorText = (e: unknown): string => {
	const message = (e as { message?: unknown } | null | undefined)?.message;
	return typeof message === 'string' ? message : String(e);
};

/** A short stable hash of a room id (FNV-1a 32 bit, base 36, 6 characters). */
export const idHash = (id: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
};

/**
 * Unique slugs per room id: the name slug plus a hash of the room id, so a route /channel/<slug> keeps opening the same
 * room when the list reorders and when an alike-named room is joined, left or renamed (a rank inside the alike-named
 * set would retarget a stale route). A hash collision falls back to a suffix in room id order.
 */
export const slugs = (rooms: ViewRoom[]): Map<string, string> => {
	const taken = new Set<string>();
	const out = new Map<string, string>();
	for (const r of [...rooms].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		let s = `${slug(r.name)}-${idHash(r.id)}`;
		while (taken.has(s)) s += '-x';
		taken.add(s);
		out.set(r.id, s);
	}
	return out;
};

/** Rocket.Chat reuses its cached rooms and subscriptions only under the same login token: one token per Matrix user. */
export const loginToken = (userId: string): string => `element-session:${userId}`;

/**
 * A `since` sync answer for Rocket.Chat's CachedStore: the snapshot as `update`, every cached id the snapshot lacks as
 * `remove`. CachedStore deletes a removed record only when it has `_deletedAt`.
 */
export const syncAnswer = <T extends { _id: string }>(snapshot: T[], cachedIds: Iterable<string>, now = new Date()) => {
	const keep = new Set(snapshot.map((d) => d._id));
	return { update: snapshot, remove: [...cachedIds].filter((id) => !keep.has(id)).map((_id) => ({ _id, _deletedAt: now })) };
};

/** Rocket.Chat's system sidebar groups in the order it lists them (`SIDEBAR_SYSTEM_GROUP_KEYS`). */
const SYSTEM_GROUPS = ['Incoming_Calls', 'Incoming_Livechats', 'Open_Livechats', 'On_Hold_Chats', 'Unread', 'Favorites', 'Teams', 'Discussions', 'Channels', 'Direct_Messages', 'Conversations'];

/**
 * M6 B1: Rocket.Chat's `sidebarCategories` user preference from Element's custom sections. A system group is an entry with
 * `default: true`; a custom category is one without. The custom ones sit right after Favorites (Element lists Favourites, the
 * custom sections, then the rest), in Element's order. The rename, show-unreads and keep-unreads-on-top fields stay at their
 * defaults: Element has no counterpart (option b scope).
 */
export const sidebarCategories = (sections: ViewSection[]) => {
	const after = SYSTEM_GROUPS.indexOf('Favorites') + 1;
	const system = (key: string) => ({ _id: key, name: key, default: true });
	const custom = [...sections].sort((a, b) => a.order - b.order).map((s) => ({ _id: s.tag, name: s.name, showUnreads: false, keepUnreadsOnTop: false }));
	return [...SYSTEM_GROUPS.slice(0, after).map(system), ...custom, ...SYSTEM_GROUPS.slice(after).map(system)];
};

/**
 * M10 W6: Element's room list sort as Rocket.Chat's `sidebarSortby` preference, which its Display menu radios (`activity`, `name`)
 * read. `unread-first` has no radio: it stays the literal value, so neither radio is checked (never faked as Activity); an unknown
 * or unreported sort leaves the preference out (Rocket.Chat's own default shows Activity).
 */
export const sidebarSortby = (sort: ViewMe['roomSort']): string | undefined =>
	sort === 'recent' ? 'activity' : sort === 'alphabetical' ? 'alphabetical' : sort === 'unread-first' ? 'unread-first' : undefined;

/**
 * `sections` (the host's custom sections, when it has them) become the user's `sidebarCategories` preference; the host's
 * `roomSort` (when it reports one) the user's `sidebarSortby`.
 */
export const toUser = (me: ViewMe, sections?: ViewSection[]): IUser => {
	const sortby = sidebarSortby(me.roomSort);
	return {
		_id: me.userId,
		username: me.userId,
		name: me.displayName,
		type: 'user',
		active: true,
		status: 'online',
		roles: ['user'],
		createdAt: new Date(0),
		_updatedAt: new Date(0),
		settings: { preferences: { ...(sections ? { sidebarCategories: sidebarCategories(sections) } : {}), ...(sortby ? { sidebarSortby: sortby } : {}) } },
		// M11 Y2: Element's Labs tab is listed. Rocket.Chat reads no such field; carrying it makes a flip a `user` change, so the user menu re-renders.
		...(me.settingsLabsTab ? { settingsLabsTab: true } : {}),
	} as unknown as IUser;
};

export const toSender = (m: ViewMessage): IUser =>
	({ _id: m.senderId, username: m.senderId, name: m.senderName, type: 'user', active: true }) as unknown as IUser;

/**
 * Rocket.Chat sorts its sidebar by last-message time; the bridge gives the room list view-model's order. The order
 * is carried as descending times from a fixed epoch, so a room that moves up gets a later time.
 */
const orderTime = (epoch: number, order: number): Date => new Date(epoch - order * 60_000);

export const toRoom = (r: ViewRoom, name: string, me: ViewMe, epoch: number): IRoom => {
	const at = orderTime(epoch, r.order);
	return {
		_id: r.id,
		t: r.isDirect ? 'd' : 'c',
		name,
		fname: r.name,
		msgs: 0,
		usersCount: r.isDirect ? 2 : 0,
		u: { _id: me.userId, username: me.userId },
		...(r.isDirect ? { uids: [me.userId], usernames: [me.userId, name] } : {}),
		ts: new Date(0),
		_updatedAt: at,
		lm: at,
	} as unknown as IRoom;
};

/**
 * A10: the notification level as Rocket.Chat's subscription fields (its notification panel reads them): `mute` is "notifications
 * off", mentions-only is the desktop alert "mentions", the other two are "all". Rocket.Chat's other notification settings
 * (mobile, e-mail, sound, counters) have no Element counterpart and stay unset. A host without the field (version 1) sets none.
 */
const notificationFields = (level: ViewRoom['notificationLevel'] | undefined): Partial<ISubscription> => (!level ? {} : {
	disableNotifications: level === 'mute',
	...(level === 'mute' ? {} : { desktopNotifications: level === 'mentions_only' ? 'mentions' : 'all', desktopPrefOrigin: 'subscription' }),
}) as Partial<ISubscription>;

/**
 * A10: Rocket.Chat's notification preferences (`/v1/rooms.saveNotification`) as one of Element's levels: notifications off or
 * the desktop alert "nothing" is `mute`, "mentions" is `mentions_only`, anything else (all, default, or only the on switch) is
 * `all_messages`. The other fields (mobile, e-mail, sound, counters, group mentions) are ignored: Element has no such setting.
 */
export const notificationLevelOf = (n: Record<string, unknown>): ViewNotificationLevel => {
	if (n.disableNotifications === '1' || n.disableNotifications === 1 || n.disableNotifications === true) return 'mute';
	if (n.desktopNotifications === 'nothing') return 'mute';
	if (n.desktopNotifications === 'mentions') return 'mentions_only';
	return 'all_messages';
};

/** `readAt`: when the kit first saw the room read (the room list view-model exposes no read time, F3). */
export const toSubscription = (r: ViewRoom, name: string, me: ViewMe, epoch: number, readAt = epoch): ISubscription => {
	const at = orderTime(epoch, r.order);
	const unread = r.unreadCount > 0 ? r.unreadCount : 0;
	return {
		_id: `s-${r.id}`,
		rid: r.id,
		name,
		fname: r.name,
		t: r.isDirect ? 'd' : 'c',
		u: { _id: me.userId, username: me.userId },
		open: true,
		// A10: a joined room that Element shows as unread without a count (a mark or an activity; the host's `showsUnread`, false
		// for a new DM's local room and a left room's preview) has Rocket.Chat's own unread look (bold name), no number.
		alert: unread > 0 || r.mentionCount > 0 || (r.membership !== 'invite' && r.showsUnread === true),
		unread,
		userMentions: r.mentionCount,
		groupMentions: 0,
		ts: new Date(0),
		// Rocket.Chat's own unread divider reads `ls` (last seen); a read room is seen since the kit saw it read, never
		// the order time (that put the last `order` minutes after `ls` and showed a divider in a read room).
		ls: unread > 0 ? new Date(0) : new Date(readAt),
		...(r.isFavourite === undefined ? {} : { f: r.isFavourite }),
		// M6 B1: the room's custom section is Rocket.Chat's subscription `category` (exclusive with the favourite, as in Rocket.Chat).
		...(r.section === undefined ? {} : { category: r.section }),
		...notificationFields(r.notificationLevel),
		lr: at,
		_updatedAt: at,
		// An invite (A5): Rocket.Chat's own invite screen with Accept and Reject. The room list view-model has no inviter,
		// so the screen names the room in that place.
		...(r.membership === 'invite' ? { status: 'INVITED', inviter: { _id: r.id, username: r.name, name: r.name } } : {}),
	} as unknown as ISubscription;
};

/**
 * E2EE trust signals (REQ-0007) as Rocket.Chat fields. A message without a readable body (pending or failed to decrypt)
 * is Rocket.Chat's own encrypted-message placeholder (`t: 'e2e'`, `e2e: 'pending'`: it hides the body and shows
 * `E2E_message_encrypted_placeholder`). The reason or warning text is `e2eWarning`, the one field Rocket.Chat has no place
 * for: the wrapper in e2e-warning.tsx shows it as a note under the message. A decrypted message keeps its text and is NOT
 * marked `t: 'e2e'`: Rocket.Chat's client resets every `t: 'e2e'` message to `e2e: 'pending'` on arrival (RoomHistoryManager
 * processMessage) and only its own E2EE service sets 'done', which would hide the text of a message the user can read.
 */
export const e2eFields = (e2e: ViewE2e | undefined): { t?: 'e2e'; e2e?: 'pending'; e2eWarning?: string } => {
	if (!e2e) return {};
	if (e2e.state === 'decrypted') return e2e.warning ? { e2eWarning: e2e.warning } : {};
	return { t: 'e2e', e2e: 'pending', ...(e2e.text ? { e2eWarning: e2e.text } : {}) };
};

/**
 * Rocket.Chat's jump route to a message in a room: its room route plus `?msg=`. A route path, not a hash: Rocket.Chat's
 * link handler routes the anchor's path (a `#/` href would be the kit document's path, Not Found, grok kit F1), and
 * reload.ts keeps that route inside the kit.
 */
export const messageLink = (room: Pick<IRoom, '_id' | 't' | 'name'> | undefined, id: string): string => `${roomPath(room)}?msg=${encodeURIComponent(jumpParam(id))}`;

/** Rocket.Chat's route path of a room (`/channel/<slug>`, `/direct/<id>`). */
export const roomPath = (room: Pick<IRoom, '_id' | 't' | 'name'> | undefined): string =>
	room?.t === 'd' ? `/direct/${encodeURIComponent(room._id)}` : `/channel/${room?.name ?? ''}`;

/**
 * The quotes at the start of a Rocket.Chat composer message and the text after them. Rocket.Chat's Quote action prefixes
 * `[ ](<permalink>)` per quoted message, one per line (`prependReplies`), the permalink being the message's room route
 * plus `?msg=<id>`; the text sent to Matrix is what follows, and the quoted ids (Rocket.Chat `_id`s, in order) are the
 * replied messages. A link that is not a quote of a message is part of the text.
 */
export const parseQuotes = (msg: string): { text: string; quoted: string[] } => {
	const quoted: string[] = [];
	let rest = msg;
	for (;;) {
		const m = /^\s*\[ \]\(([^)\s]*[?&]msg=([^)\s&#]+)[^)\s]*)\)[ \t]*\n?/.exec(rest);
		if (!m) break;
		let id = m[2];
		try {
			id = decodeURIComponent(id);
		} catch {
			// an id that is not percent-encoded stays as it is
		}
		quoted.push(id);
		rest = rest.slice(m[0].length);
	}
	return { text: quoted.length ? rest.trim() : msg, quoted };
};

/**
 * The `msg` value of a jump: Rocket.Chat decodes its query string twice (page.ts, then URLSearchParams), harmless for
 * its own alphanumeric ids, but a room v1-v3 event id with `+`, `%` or `&` would name another event (kit inc1 F4). One
 * extra encoding here makes the double decode return the id.
 */
export const jumpParam = (id: string): string => encodeURIComponent(id);

/**
 * An Element reply is Rocket.Chat's quote attachment (QuoteAttachment.tsx: author, jump link, text). The quoted text is
 * plain (Rocket.Chat parses `text` as plain text when there is no `md`); an unreadable quoted message has none.
 */
export const quoteOf = (m: ViewMessage, room?: Pick<IRoom, '_id' | 't' | 'name'>, idOf: (eventId: string) => string = (id) => id) =>
	m.replyTo && {
		author_name: m.replyTo.senderName,
		author_icon: initialAvatar(m.replyTo.senderName),
		// The id the kit renders the quoted message under (F1), so the jump finds the row in the list.
		message_link: messageLink(room, idOf(m.replyTo.eventId)),
		text: m.replyTo.text,
	};

/** The scheme of the link a file attachment gets when Element downloads it (see {@link downloadHref}). */
export const DOWNLOAD_SCHEME = 'evw-download:';

/**
 * The `title_link` of a file whose bytes only Element can hand over (an encrypted file has no URL the frame can load).
 * Rocket.Chat renders its download control and its title as anchors on it; the kit's click handler (`download-link.ts`)
 * answers them with `bridge.download(rid, eventId)`.
 */
export const downloadHref = (rid: string, id: string): string => `${DOWNLOAD_SCHEME}${encodeURIComponent(rid)}/${encodeURIComponent(id)}`;

/** The room and event a {@link downloadHref} names, or undefined for any other href. */
export const parseDownloadHref = (href: string): { rid: string; id: string } | undefined => {
	if (!href.startsWith(DOWNLOAD_SCHEME)) return undefined;
	const [rid, id, ...rest] = href.slice(DOWNLOAD_SCHEME.length).split('/');
	if (!rid || !id || rest.length) return undefined;
	try {
		return { rid: decodeURIComponent(rid), id: decodeURIComponent(id) };
	} catch {
		return undefined;
	}
};

/** Rocket.Chat's own video player is at most this wide (`VideoAttachment`: `maxWidth: 368`). */
const VIDEO_BOX_WIDTH = 368;

/**
 * The size of the "Click to load" box of a hidden media body. An image keeps its own size (as Rocket.Chat does). A video takes
 * the footprint of the player it becomes, `VIDEO_BOX_WIDTH` wide with the video's aspect (M13 U2): its own pixel size (a 16x16
 * clip) would make a box too small to hold the "Click to load" text, which wraps and overflows over the composer, so the click
 * lands on the composer. Unknown sizes leave the box at Rocket.Chat's default.
 */
const hiddenDimensions = (media: ViewMedia): { image_dimensions?: { width: number; height: number } } => {
	if (!media.width || !media.height) return {};
	if (media.kind === 'video') return { image_dimensions: { width: VIDEO_BOX_WIDTH, height: Math.round((VIDEO_BOX_WIDTH * media.height) / media.width) } };
	return { image_dimensions: { width: media.width, height: media.height } };
};

/**
 * An Element media body as Rocket.Chat's file attachment (`type: 'file'`; AttachmentsItem picks the image, video, audio
 * or generic file component from `image_url` / `video_url` / `audio_url`). An image shows its thumbnail and links the full image. A
 * file that has no URL (an encrypted file keeps its decrypted blob private to its view-model) links {@link downloadHref}
 * when Element offers its download (`message`: `ViewMessage.canDownload`, B7); media that is loading, hidden or in error
 * is the generic file attachment carrying Element's own text and no link. The sizes and the file type are left out: the
 * view-models expose none (a file's size is inside its label).
 *
 * M12 Z3 (R1, R4), M13 U2 (R1): a HIDDEN IMAGE OR VIDEO on a host that can reveal it (`message.canShowMedia`: bridge version 6
 * `showMedia`, which accepts both) is an image attachment with no URL (`image_url` is an empty string, which only routes it to
 * the image component; Rocket.Chat's own video attachment has no load control) and the kit marker `kitHiddenMedia: { rid, eventId }`;
 * the swapped image attachment (`src/image-attachment.tsx`) renders Rocket.Chat's own "Click to load" box for it, and the press
 * is Element's reveal. The video arrives with the next snapshot as an ordinary `video_url` attachment. Without `showMedia`
 * it stays the file-name row above.
 */
export const mediaAttachment = (media: ViewMedia | undefined, message?: { rid: string; id: string; canDownload?: boolean; canShowMedia?: boolean }) => {
	if (!media) return undefined;
	const title = media.name || media.label || media.kind;
	if (media.state === 'hidden' && (media.kind === 'image' || media.kind === 'video') && !media.url && message?.canShowMedia) {
		return {
			type: 'file',
			title,
			image_url: '',
			...hiddenDimensions(media),
			kitHiddenMedia: { rid: message.rid, eventId: message.id },
		};
	}
	if (media.state === 'ready' && !media.url && media.kind === 'file' && message?.canDownload) {
		return { type: 'file', title, title_link: downloadHref(message.rid, message.id), title_link_download: true };
	}
	if (media.state !== 'ready' || !media.url) return { type: 'file', title };
	const link = { title_link: media.url, title_link_download: true };
	if (media.kind === 'image') {
		return {
			type: 'file',
			title,
			...link,
			image_url: media.thumbnailUrl ?? media.url,
			...(media.width && media.height ? { image_dimensions: { width: media.width, height: media.height } } : {}),
		};
	}
	if (media.kind === 'video') return { type: 'file', title, ...link, video_url: media.url };
	if (media.kind === 'audio') return { type: 'file', title, ...link, audio_url: media.url };
	return { type: 'file', title, ...link };
};

let reactionName = (key: string): string => key;

/** Installs the Matrix reaction key (an emoji) to Rocket.Chat emoji name lookup; the bundle passes Rocket.Chat's own. */
export const setReactionName = (lookup: (key: string) => string): void => {
	reactionName = lookup;
};

let reactionUnicode = (_name: string): string | undefined => undefined;

/** Installs the Rocket.Chat emoji name to Matrix reaction key (the emoji itself) lookup; the bundle passes Rocket.Chat's own. */
export const setReactionUnicode = (lookup: (name: string) => string | undefined): void => {
	reactionUnicode = lookup;
};

const withoutSelector = (s: string): string => s.replace(/\uFE0F/g, '');

const SHORTCODE = /:([a-z0-9_+-]+):/gi;
// A run of shortcodes (`:smile::tada:`) starts at a word boundary; each one of the run converts.
const SHORTCODE_RUN = /(?<![\w:])(?::[a-z0-9_+-]+:)+(?!\w)/gi;
// Spans left as typed: code fences and spans, and URLs (scheme://... up to whitespace).
const LITERAL = /(```[\s\S]*?```|`[^`\n]*`|[a-z][a-z0-9+.-]*:\/\/\S+)/i;

/**
 * B3: a composer draft as Matrix text. A known Rocket.Chat `:shortcode:` (typed, or left by the emoji autocomplete or a
 * picker entry without Unicode) becomes the Unicode emoji, so every Matrix client reads it; an unknown one stays text, and
 * code spans, fences and URLs are left alone.
 */
export const shortcodesToUnicode = (text: string): string =>
	text
		.split(LITERAL)
		.map((part, i) =>
			i % 2
				? part
				: part.replace(SHORTCODE_RUN, (run) =>
						run.replace(SHORTCODE, (whole, name: string) => reactionUnicode(`:${name.toLowerCase()}:`) ?? whole),
					),
		)
		.join('');

/**
 * The Matrix reaction key for a Rocket.Chat emoji name (`:thumbsup:`, with or without the colons) on a message, or
 * undefined when the name is none Rocket.Chat knows. A key the message already carries wins (the chip pressed is that
 * key, whatever variation selector Element's picker or another client sent it with, or a text key such as "lol" whose
 * name is the key); else the emoji itself. Where several keys share the name (they merge into one chip), the user's own
 * key wins, so pressing the chip removes the user's reaction instead of adding one on another key; else the order.
 */
export const reactionKeyFor = (m: ViewMessage | undefined, name: string): string | undefined => {
	const wanted = name.startsWith(':') && name.endsWith(':') ? name : `:${name}:`;
	const named = (m?.reactions ?? []).filter((r) => reactionName(r.key) === name || reactionName(r.key) === wanted);
	const own = named.find((r) => r.mine) ?? named[0];
	if (own) return own.key;
	const unicode = reactionUnicode(wanted);
	if (!unicode) return undefined;
	const alikes = (m?.reactions ?? []).filter((r) => withoutSelector(r.key) === withoutSelector(unicode));
	return (alikes.find((r) => r.mine) ?? alikes[0])?.key ?? unicode;
};

/**
 * Element reactions as Rocket.Chat's `reactions` field: keyed by emoji name (`:thumbsup:`; a key without one stays as
 * it is), the senders as usernames (= Matrix user ids here, so Rocket.Chat's "mine" is the user's own id among them).
 * Keys that share one name merge their senders.
 */
export const reactionsOf = (m: ViewMessage): Record<string, { usernames: string[] }> | undefined => {
	if (!m.reactions?.length) return undefined;
	const out: Record<string, { usernames: string[] }> = {};
	for (const r of m.reactions) {
		const name = reactionName(r.key);
		const usernames = out[name]?.usernames ?? [];
		out[name] = { usernames: [...new Set([...usernames, ...r.senderIds])] };
	}
	return out;
};

/**
 * The Rocket.Chat emoji names (`smile`, no colons) of the reactions the signed-in user newly has on `now` since `before`
 * (a view of the same message the kit saw earlier). A key without a name (`:name:`) is left out: it is no emoji to remember.
 * Nothing is new when `before` could not carry reactions: the host shows no chips where the content is not actionable
 * (redacted, undecryptable, an edit not yet decrypted: the view then marks `redacted` or `e2e` pending / failed), so
 * reactions that reappear after it are old ones, not a reaction the user just made. A first reaction on a message that
 * was actionable but had none still counts.
 */
export const newOwnReactionNames = (before: ViewMessage, now: ViewMessage): string[] => {
	if (before.redacted || before.e2e?.state === 'pending' || before.e2e?.state === 'failed') return [];
	const had = new Set((before.reactions ?? []).filter((r) => r.mine).map((r) => r.key));
	const out: string[] = [];
	for (const r of now.reactions ?? []) {
		if (!r.mine || had.has(r.key)) continue;
		const named = /^:([^:\s]+):$/.exec(reactionName(r.key));
		if (named && !out.includes(named[1])) out.push(named[1]);
	}
	return out;
};

/**
 * An Element thread summary as Rocket.Chat's thread-main-message fields (`isThreadMainMessage`: `tcount` + `tlm`), which
 * render its own thread metrics under the message: "View thread", the participants (`replies`, user ids = Matrix user
 * ids here) and the reply count with the last reply's date. Opening the thread is N/A (an overlay marks the button).
 */
export const threadFields = (m: ViewMessage): { tcount?: number; tlm?: Date; replies?: string[] } => {
	if (!m.thread || m.thread.replyCount < 1) return {};
	return { tcount: m.thread.replyCount, tlm: new Date(m.thread.lastReplyTs), replies: [...m.thread.participantIds] };
};

// Rocket.Chat renders the site footer as markdown `[ogSiteName](ogUrl)` (OEmbedPreviewContent), and both come from the
// sender's open-graph data (grok inc 8/4 F1): the link is Element's own target, made markdown-safe, and the name loses
// markdown syntax, so neither can become a foreign link or a remote image.
const footerUrl = (link: string): string | undefined => {
	try {
		const url = new URL(link);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
		return url.href.replace(/[()[\]<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
	} catch {
		return undefined;
	}
};
const footerText = (text?: string): string | undefined => text?.replace(/[[\]()!<>*_~`\\|]/g, ' ').trim();

/**
 * Element's link previews as Rocket.Chat's message `urls`: its own link preview (UrlPreviews, OEmbedLinkPreview) reads the
 * open-graph `meta` of each entry. A page URL (`ogUrl`) is what makes it show the site name; it is the preview link,
 * where Element navigates (Element shows the site name as text and never follows og:url). Rocket.Chat shows an author
 * only with an author link, which the view-model has none of: left out. No previews (Element hides them, or none was
 * found) is no `urls` at all.
 */
export const urlsOf = (m: ViewMessage) => {
	if (!m.urlPreviews?.length) return undefined;
	return m.urlPreviews.map((p) => ({
		url: p.link,
		meta: Object.fromEntries(
			Object.entries({
				ogTitle: p.title,
				ogSiteName: footerText(p.siteName),
				ogUrl: footerUrl(p.link),
				ogDescription: p.description,
				ogImage: p.image?.url,
				ogImageWidth: p.image?.width?.toString(),
				ogImageHeight: p.image?.height?.toString(),
			}).filter(([, value]) => value),
		),
	}));
};

/** Rocket.Chat's provider name for the call (the call itself runs in aqua-meet). */
export const CALL_PROVIDER = 'aqua-meet';

/**
 * The call root event as the message Rocket.Chat's server writes for a conference (`t: 'videoconf'`, one `video_conf`
 * block): `VideoConfMessage` draws the card and asks `video-conference.info` for everything else. The text is invisible
 * in the room (a message with blocks renders the blocks); it names the message in lists and previews.
 */
const videoConfMessage = (call: ViewCall): Partial<IMessage> =>
	({
		t: 'videoconf',
		msg: 'Video Conference',
		groupable: false,
		blocks: [{ type: 'video_conf', blockId: call.callId, callId: call.callId, appId: 'videoconf-core' }],
	}) as unknown as Partial<IMessage>;

/**
 * The system line of an encryption event (Element's `EncryptionEventViewModel`): Rocket.Chat's "End-to-end encryption
 * enabled" (`room_e2e_enabled`, a system message the client draws from its own text; the body stays empty). Only the
 * three states that say encryption is on map; `changed`, `disable_attempt` and `unsupported` have no matching Rocket.Chat
 * type (`room_e2e_disabled` would claim encryption was turned off), so they give no line (`undefined`).
 */
export const encryptionLine = (e: ViewEncryption): Partial<IMessage> | undefined =>
	e.state === 'enabled' || e.state === 'enabled_dm' || e.state === 'enabled_local'
		? ({ t: 'room_e2e_enabled', msg: '', groupable: false } as unknown as Partial<IMessage>)
		: undefined;

/**
 * Rocket.Chat's `VideoConference` (the answer of `video-conference.info`) from the call the bridge handed over. The state
 * is Element's (the root tile view-model: ongoing or a tombstone); what no view-model carries is not invented: an ended
 * call has no member list and no end time of its own, so `endedAt` is the moment the caller observed the end (the call's
 * start when it was first seen already ended), a value Rocket.Chat's card never shows. A DM is a `videoconference` as well
 * (no ringing, so no `direct` call that waits to be answered). Rocket.Chat 8.9 reads `'endedAt' in data` for the ended card.
 */
/**
 * The member of a call that Element counts and the view-models do not name (the face pile shows at most three of a room
 * tile's `participantCount`). Rocket.Chat counts `joinedUsers` (a non-empty username, joined) for "+ N joined" and the
 * tooltip's "and N more", and draws and names only the first three; these entries come after the named ones, so they are
 * counted and never drawn or named. The username is one zero-width space (non-empty for the count, nothing to read).
 */
const countOnlyUser = (callId: string, index: number, ts: Date) => ({ _id: `${callId}#${index}`, username: '\u200b', name: '', avatarETag: null, ts, joined: true, joinedAt: ts });

export const toVideoConference = (m: ViewMessage, endedAt: number): Record<string, unknown> => {
	const call = m.call!;
	const ongoing = call.state === 'ongoing';
	const ts = new Date(call.startedTs);
	return {
		_id: call.callId,
		_updatedAt: ts,
		type: 'videoconference',
		rid: m.roomId,
		users: [
			...call.participants.map((p) => ({ _id: p.userId, username: p.userId, name: p.name, avatarETag: null, ts, joined: true, joinedAt: ts })),
			...(ongoing ? Array.from({ length: Math.max(0, (call.participantCount ?? 0) - call.participants.length) }, (_, i) => countOnlyUser(call.callId, i, ts)) : []),
		],
		status: ongoing ? 1 : call.declined ? 4 : 3,
		messages: { started: m.id },
		createdBy: { _id: m.senderId, username: m.senderId, name: m.senderName },
		createdAt: ts,
		providerName: CALL_PROVIDER,
		...(ongoing ? {} : { endedAt: new Date(endedAt) }),
		// No toggles the call app would ignore (see `/v1/video-conference.capabilities`): Rocket.Chat's incoming-call popup reads these.
		capabilities: {},
		success: true,
	};
};

export const toMessage = (m: ViewMessage, room?: Pick<IRoom, '_id' | 't' | 'name'>, idOf?: (eventId: string) => string, host?: { canShowMedia?: boolean }): IMessage => {
	const e2e = e2eFields(m.e2e);
	const quote = quoteOf(m, room, idOf);
	const reactions = reactionsOf(m);
	const thread = threadFields(m);
	const media = mediaAttachment(m.media, { rid: m.roomId, id: m.id, canDownload: m.canDownload, canShowMedia: host?.canShowMedia });
	const urls = urlsOf(m);
	const attachments = [quote, media].filter(Boolean);
	// An edited message shows Rocket.Chat's own "(edited)" mark, timed by the replacement (`editedTs`); a host that does
	// not name it leaves the message's own time standing in. `kitCanEdit` is Element's edit rule (the swapped edit action reads it).
	const edited = m.edited ? { editedAt: new Date(m.editedTs ?? m.ts), editedBy: { _id: m.senderId, username: m.senderId } } : {};
	return {
		_id: m.id,
		rid: m.roomId,
		// The bridge promises a string body (emoji-only included); anything else would render an empty message. A message
		// that is not decrypted never carries its body (the bridge sends none; Rocket.Chat hides it anyway). A media message's
		// body is its file name, which the attachment shows: no text of its own, as Element shows none.
		msg: e2e.e2e === 'pending' || media ? '' : typeof m.body === 'string' ? fromCommonMark(m.body, { formatted: !!m.formattedBody }) : '',
		u: { _id: m.senderId, username: m.senderId, name: m.senderName },
		ts: new Date(m.ts),
		_updatedAt: new Date(m.ts),
		...(attachments.length ? { attachments } : {}),
		...(urls ? { urls } : {}),
		...(reactions ? { reactions } : {}),
		...thread,
		...edited,
		kitCanEdit: m.canEdit === true,
		// Element's pin rule (ViewMessage.canPin): the swapped pin / unpin actions read it. The pinned mark is Rocket.Chat's own.
		kitCanPin: m.canPin === true,
		// Element's Copy Markdown rule (ViewMessage.canCopyMarkdown): the swapped WebDAV slot of the "More" menu carries the item.
		kitCanCopyMarkdown: m.canCopyMarkdown === true,
		pinned: m.pinned === true,
		// The host has no report row for a call card or an encryption line (the press would end in unknown_event): the swapped report action reads this.
		kitCanReport: !m.call && !m.encryption,
		// Element's permalink of the event (the swapped permalink action copies it); absent = no "Copy link".
		...(m.permalink ? { kitPermalink: m.permalink } : {}),
		...e2e,
		...(m.call ? videoConfMessage(m.call) : {}),
		...(m.encryption ? encryptionLine(m.encryption) : {}),
	} as unknown as IMessage;
};

/** Avatar URL for a Rocket.Chat avatar lookup key (a username = a Matrix user id here, or a room id). */
export const avatarFor = (
	key: string,
	{ me, rooms, senders }: { me: ViewMe; rooms: ViewRoom[]; senders: Map<string, ViewMessage> },
): string | undefined => {
	if (key === me.userId) return me.avatarUrl;
	const room = rooms.find((r) => r.id === key);
	if (room) return room.avatarUrl;
	return senders.get(key)?.senderAvatarUrl;
};

/** A neutral initial avatar (inline SVG), so a missing avatar never turns into a request to a Rocket.Chat server. */
export const initialAvatar = (label: string): string => {
	const ch = (label.replace(/^[@#!]/, '').trim()[0] ?? '?').toUpperCase();
	const safe = ch.replace(/[<>&"']/g, '?');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#6c727a"/><text x="16" y="21" font-size="16" text-anchor="middle" fill="#fff" font-family="sans-serif">${safe}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/** The Rocket.Chat types the kit draws from events that are no Matrix `m.room.message`: Element's quick reaction skips them. */
const NO_MESSAGE_EVENT_TYPES = new Set(['room_e2e_enabled', 'videoconf', 'e2e']);
export const isNoMessageEvent = (m: IMessage): boolean => NO_MESSAGE_EVENT_TYPES.has(String((m as { t?: string }).t ?? ''));
