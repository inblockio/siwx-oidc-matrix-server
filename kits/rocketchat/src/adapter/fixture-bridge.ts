// A fixed bridge for running the kit without Element (standalone serve) and for unit tests.
import type { ClientViewBridge, ViewConnection, ViewMe, ViewMessage, ViewNotificationLevel, ViewRoom, ViewSection, ViewSettingsTab } from '../bridge-types.ts';

export const fixtureBridge = (): ClientViewBridge & { emit(e: Parameters<Parameters<ClientViewBridge['onChange']>[0]>[0]): void; reads: string[]; switches: string[]; conn: ViewConnection; sent: { roomId: string; text: string; txnId?: string; replyTo?: string; markdown?: boolean; mentions?: string[] }[]; editOpts: ({ markdown?: boolean; mentions?: string[] } | undefined)[]; mentionQueries: string[][]; sendMode: 'echo-first' | 'resolve-first' | 'reject' | 'reject-after-echo' | 'reject-lost'; lost: { deliver(): void } | undefined; actionMode: 'ok' | 'reject'; edits: string[][]; deletes: string[][]; pins: (string | boolean)[][]; reacts: string[][]; quickReacts: string[][]; quickReactResult: Error | undefined; downloads: string[][]; downloadResult: Error | undefined; itemCalls: string[][]; logouts: number; logoutResult: { status: 'cancelled' } | Error | undefined; uploads: string[]; uploadFiles: (string[] | undefined)[]; uploadResult: { status: 'cancelled' } | Error | undefined; itemFail: Error | undefined; sectionList: ViewSection[]; createSectionResult: { status: 'cancelled' } | Error | { section: string }; editSectionResult: { status: 'cancelled' } | Error | { name: string }; removeSectionResult: { status: 'cancelled' } | Error | { removed: true }; pickers: string[][]; forwards: string[][]; forwardResult: Error | undefined; forwardJump: string | undefined; reports: string[][]; viewSources: string[][]; viewSourceResult: Error | undefined; panels: string[][]; userInfos: string[][]; userInfoResult: Error | undefined; copyMarkdowns: string[][]; copyMarkdownResult: Error | undefined; panelCloses: number; panelResult: Error | undefined; emitJump(j: { roomId: string; eventId: string }): void; emitRoomOpen(j: { roomId: string }): void; encryption(roomId: string, state: NonNullable<ViewMessage['encryption']>['state'] | undefined, userName?: string): void; retention(roomId: string, id: string, text: string): void; expire(roomId: string, id: string): void; threads: string[][]; threadCloses: number; threadResult: Error | undefined; olderPages: Record<string, ViewMessage[][]>; olderResult?: { atStart?: boolean; atLimit?: boolean; ids?: string[] | undefined }; olderCalls: string[]; joins: string[]; invites: { op: 'accept' | 'decline'; roomId: string }[]; leaves: string[]; creates: string[]; directoryCalls: ({ term?: string; filter?: 'rooms' | 'people' } | undefined)[]; dmCalls: string[]; dmFromRooms: (string | undefined)[]; meet: string | undefined; roomResult: { openDirectory?: { status: 'cancelled' } | Error | { roomId: string; peek?: boolean }; join?: Error | { roomId: string }; createRoom?: { status: 'cancelled' } | Error | { roomId: string }; createChat?: { status: 'cancelled' } | Error | { roomId: string }; startDm?: { status: 'cancelled' } | Error | { roomId: string }; leave?: { status: 'cancelled' } | Error }; userSettingsOpens: number; userSettingsTabs: (string | undefined)[]; settingsLabsTab: boolean | undefined; userSettingsResult: Error | undefined; sortCalls: string[]; sortResult: Error | undefined; roomSort: ViewMe['roomSort']; mediaReveals: string[][]; showMediaResult: Error | undefined; putMessage(roomId: string, m: ViewMessage): void } => {
	const now = Date.now();
	const ago = (min: number) => now - min * 60_000;
	// A10 fields at their defaults; a spec changes them through the A10 methods.
	const base = (r: Omit<ViewRoom, 'isFavourite' | 'canMarkAsUnread' | 'showsUnread' | 'notificationLevel'>): ViewRoom => ({ isFavourite: false, canMarkAsUnread: true, showsUnread: false, notificationLevel: 'all_messages', ...r });
	const rooms: ViewRoom[] = [
		base({ id: '!general:example.org', name: 'General Chat', unreadCount: 0, mentionCount: 0, isDirect: false, order: 0 }),
		base({ id: '!random:example.org', name: 'Random', unreadCount: 1, mentionCount: 1, isDirect: false, order: 1, avatarUrl: 'https://example.org/_matrix/media/v3/thumbnail/random' }),
		base({ id: '!bob:example.org', name: 'Bob', unreadCount: 0, mentionCount: 0, isDirect: true, order: 2 }),
	];
	const msg = (id: string, roomId: string, senderId: string, senderName: string, body: string, min: number): ViewMessage => ({ id, roomId, senderId, senderName, body, ts: ago(min), kind: 'text' });
	const timelines: Record<string, ViewMessage[]> = {
		'!general:example.org': [msg('$m1', '!general:example.org', '@alice:example.org', 'Alice', 'Hello **world**, this is _markdown_', 10), msg('$m2', '!general:example.org', '@bob:example.org', 'Bob', '🎉', 5)],
		'!random:example.org': [msg('$m3', '!random:example.org', '@bob:example.org', 'Bob', 'Anyone up for lunch?', 20)],
	};
	const listeners = new Set<Parameters<ClientViewBridge['onChange']>[0]>();
	const jumpListeners = new Set<Parameters<ClientViewBridge['onJump']>[0]>();
	const roomOpenListeners = new Set<Parameters<ClientViewBridge['onRoomOpen']>[0]>();
	const b = {
		version: 8 as 2 | 3 | 4 | 5 | 6 | 7 | 8,
		reads: [] as string[],
		// The call app's address of the host config (calls are off while it is undefined).
		meet: undefined as string | undefined,
		meetUrl: () => b.meet,
		sent: [] as { roomId: string; text: string; txnId?: string; replyTo?: string; markdown?: boolean; mentions?: string[] }[],
		mentionQueries: [] as string[][],
		editOpts: [] as ({ markdown?: boolean; mentions?: string[] } | undefined)[],
		// Order of a send's two signals: the confirming row before the promise resolves, after it, or an error.
		sendMode: 'resolve-first' as 'echo-first' | 'resolve-first' | 'reject' | 'reject-after-echo' | 'reject-lost',
		// 'reject-lost': the homeserver took the message, the answer was lost and the echo has not arrived yet (`lost.deliver()` brings it).
		lost: undefined as { deliver(): void } | undefined,
		// The homeserver's transaction table: a repeated transaction id answers with the first event, it posts nothing new.
		accepted: new Map<string, string>(),
		// The edit and delete actions: done (the timeline changes), or refused.
		actionMode: 'ok' as 'ok' | 'reject',
		edits: [] as string[][],
		deletes: [] as string[][],
		pins: [] as (string | boolean)[][],
		reacts: [] as string[][],
		quickReacts: [] as string[][],
		quickReactResult: undefined as Error | undefined,
		downloads: [] as string[][],
		downloadResult: undefined as Error | undefined,
		// M12 Z3: the calls of `showMedia` (room, event) and its refusal; `putMessage` seeds or replaces a message (a hidden image) and fires a timeline change.
		mediaReveals: [] as string[][],
		showMediaResult: undefined as Error | undefined,
		putMessage: (roomId: string, m: ViewMessage) => {
			timelines[roomId] = [...(timelines[roomId] ?? []).filter((x) => x.id !== m.id), m];
			b.emit({ kind: 'timeline', roomId });
		},
		pickers: [] as string[][],
		forwards: [] as string[][],
		forwardResult: undefined as Error | undefined,
		forwardJump: undefined as string | undefined,
		viewSources: [] as string[][],
		viewSourceResult: undefined as Error | undefined,
		threads: [] as string[][],
		threadCloses: 0,
		threadResult: undefined as Error | undefined,
		panels: [] as string[][],
		userInfos: [] as string[][],
		userInfoResult: undefined as Error | undefined,
		copyMarkdowns: [] as string[][],
		copyMarkdownResult: undefined as Error | undefined,
		panelCloses: 0,
		panelResult: undefined as Error | undefined,
		reports: [] as string[][],
		// Older history per room: each loadOlder brings in the next page (nearest first). `olderResult` overrides the flags.
		olderPages: {} as Record<string, ViewMessage[][]>,
		olderResult: undefined as { atStart?: boolean; atLimit?: boolean; ids?: string[] | undefined } | undefined,
		olderCalls: [] as string[],
		// A5-A7: what the bridge was asked, and how the next call ends (default: done).
		joins: [] as string[],
		invites: [] as { op: 'accept' | 'decline'; roomId: string }[],
		leaves: [] as string[],
		itemCalls: [] as string[][],
		logouts: 0,
		logoutResult: undefined as { status: 'cancelled' } | Error | undefined,
		// M10 W4/W6: the profile dialog opens, the sort options the host was asked for, how they end, and the sort `me()` reports.
		userSettingsOpens: 0,
		// M11 Y2: the tab each open asked for (undefined: no options), and what `me()` reports as `settingsLabsTab` (undefined: not reported).
		userSettingsTabs: [] as (string | undefined)[],
		settingsLabsTab: undefined as boolean | undefined,
		userSettingsResult: undefined as Error | undefined,
		sortCalls: [] as string[],
		sortResult: undefined as Error | undefined,
		roomSort: undefined as ViewMe['roomSort'],
		uploads: [] as string[],
		uploadFiles: [] as (string[] | undefined)[],
		uploadResult: undefined as { status: 'cancelled' } | Error | undefined,
		itemFail: undefined as Error | undefined,
		creates: [] as string[],
		// M10 W1: what openDirectory was asked (the options as given), and how it ends (roomResult.openDirectory).
		directoryCalls: [] as ({ term?: string; filter?: 'rooms' | 'people' } | undefined)[],
		// M11 Y4: the user ids startDm was asked for, and how it ends (roomResult.startDm).
		dmCalls: [] as string[],
		// M12 Z2 F1: the room of the message each startDm was asked from (the optional second argument).
		dmFromRooms: [] as (string | undefined)[],
		roomResult: {} as { openDirectory?: { status: 'cancelled' } | Error | { roomId: string; peek?: boolean }; join?: Error | { roomId: string }; createRoom?: { status: 'cancelled' } | Error | { roomId: string }; createChat?: { status: 'cancelled' } | Error | { roomId: string }; startDm?: { status: 'cancelled' } | Error | { roomId: string }; leave?: { status: 'cancelled' } | Error },
		switches: [] as string[],
		conn: 'online' as ViewConnection,
		me: (): ViewMe => ({ userId: '@alice:example.org', displayName: 'Alice', ...(b.roomSort ? { roomSort: b.roomSort } : {}), ...(b.settingsLabsTab !== undefined ? { settingsLabsTab: b.settingsLabsTab } : {}) }),
		rooms: () => rooms,
		// Oldest first by time, like the real bridge (its snapshot is sorted by ts): position is time order.
		timeline: (roomId: string) => (timelines[roomId] ?? []).sort((a, b) => a.ts - b.ts),
		markRead: (roomId: string) => {
			b.reads.push(roomId);
			const r = rooms.find((x) => x.id === roomId);
			if (r) Object.assign(r, { unreadCount: 0, mentionCount: 0 });
			b.emit({ kind: 'rooms' });
		},
		connection: () => b.conn,
		views: () => [{ id: 'stock', name: 'Element' }, { id: 'rocketchat', name: 'Rocket.Chat' }],
		switchTo: (viewId: string) => void b.switches.push(viewId),
		sendText: async (roomId: string, text: string, opts?: { txnId?: string; replyTo?: string; markdown?: boolean; mentions?: string[] }) => {
			b.sent.push({ roomId, text, txnId: opts?.txnId, ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}), ...(opts?.markdown ? { markdown: true } : {}), ...(opts?.mentions?.length ? { mentions: opts.mentions } : {}) });
			if (b.sendMode === 'reject') throw Object.assign(new Error('not allowed'), { code: 'forbidden' });
			const first = opts?.txnId ? b.accepted.get(opts.txnId) : undefined;
			const eventId = first ?? `$sent${b.sent.length}`;
			if (opts?.txnId) b.accepted.set(opts.txnId, eventId);
			const reply = opts?.replyTo ? (timelines[roomId] ?? []).find((m) => m.id === opts.replyTo) : undefined;
			const echo = () => {
				if ((timelines[roomId] ?? []).some((m) => m.id === eventId)) return;
				timelines[roomId] = [
					...(timelines[roomId] ?? []),
					{
						...msg(eventId, roomId, '@alice:example.org', 'Alice', text, 0),
						txnId: opts?.txnId,
						canEdit: true,
						...(reply ? { replyTo: { eventId: reply.id, senderId: reply.senderId, senderName: reply.senderName, text: reply.body } } : {}),
					},
				];
				b.emit({ kind: 'timeline', roomId });
			};
			if (b.sendMode === 'reject-after-echo') {
				// The homeserver took the message and its echo arrived, but the call failed (the answer was lost).
				echo();
				throw Object.assign(new Error('connection lost'), { code: 'network' });
			}
			if (b.sendMode === 'reject-lost' && !first) {
				b.lost = { deliver: echo };
				throw Object.assign(new Error('connection lost'), { code: 'network' });
			}
			if (b.sendMode === 'echo-first') echo();
			else setTimeout(echo, 0);
			return { status: 'done' as const, roomId, eventId };
		},
		mentionCandidates: async (roomId: string, query: string) => {
			b.mentionQueries.push([roomId, query]);
			if (!rooms.some((r) => r.id === roomId)) throw Object.assign(new Error('unknown room'), { code: 'unknown_room' });
			const q = query.toLowerCase();
			return [{ userId: '@bob:example.org', displayName: 'Bob' }, { userId: '@carol:example.org', displayName: 'Carol' }].filter((u) => u.displayName.toLowerCase().includes(q) || u.userId.slice(1).includes(q));
		},
		editText: async (roomId: string, eventId: string, text: string, opts?: { markdown?: boolean; mentions?: string[] }) => {
			b.edits.push([roomId, eventId, text]);
			b.editOpts.push(opts);
			if (b.actionMode === 'reject') throw Object.assign(new Error('not allowed'), { code: 'forbidden' });
			timelines[roomId] = (timelines[roomId] ?? []).map((m) => (m.id === eventId ? { ...m, body: text, edited: true as const, editedTs: Date.now() } : m));
			b.emit({ kind: 'timeline', roomId });
			return { status: 'done' as const, roomId, eventId };
		},
		setPinned: async (roomId: string, eventId: string, on: boolean) => {
			b.pins.push([roomId, eventId, on]);
			if (b.actionMode === 'reject') throw Object.assign(new Error('not allowed'), { code: 'forbidden' });
			timelines[roomId] = (timelines[roomId] ?? []).map((m) => (m.id === eventId ? { ...m, pinned: on } : m));
			b.emit({ kind: 'timeline', roomId });
			return { status: 'done' as const, roomId };
		},
		redact: async (roomId: string, eventId: string) => {
			b.deletes.push([roomId, eventId]);
			if (b.actionMode === 'reject') throw Object.assign(new Error('not allowed'), { code: 'forbidden' });
			timelines[roomId] = (timelines[roomId] ?? []).map((m) => (m.id === eventId ? { ...m, body: 'Message deleted', kind: 'other' as const, redacted: true as const } : m));
			b.emit({ kind: 'timeline', roomId });
			return { status: 'done' as const, roomId, eventId };
		},
		join: async (roomIdOrAlias: string) => {
			b.joins.push(roomIdOrAlias);
			const r = b.roomResult.join;
			if (r instanceof Error) throw r;
			const roomId = r?.roomId ?? roomIdOrAlias;
			if (!rooms.some((x) => x.id === roomId)) {
				rooms.push(base({ id: roomId, name: roomId, unreadCount: 0, mentionCount: 0, isDirect: false, order: rooms.length }));
				b.emit({ kind: 'rooms' });
			}
			return { status: 'done' as const, roomId };
		},
		acceptInvite: async (roomId: string) => {
			b.invites.push({ op: 'accept', roomId });
			const r = rooms.find((x) => x.id === roomId);
			if (r) r.membership = 'join';
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		declineInvite: async (roomId: string) => {
			b.invites.push({ op: 'decline', roomId });
			const at = rooms.findIndex((x) => x.id === roomId);
			if (at >= 0) rooms.splice(at, 1);
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		createRoom: async () => {
			b.creates.push('room');
			const r = b.roomResult.createRoom;
			if (r instanceof Error) throw r;
			if (r && 'status' in r) return r;
			const roomId = r?.roomId ?? '!created:example.org';
			rooms.push(base({ id: roomId, name: 'Created', unreadCount: 0, mentionCount: 0, isDirect: false, order: rooms.length }));
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		createChat: async () => {
			b.creates.push('chat');
			const r = b.roomResult.createChat;
			if (r instanceof Error) throw r;
			if (r && 'status' in r) return r;
			const roomId = r?.roomId ?? 'local+dm';
			rooms.unshift(base({ id: roomId, name: 'Carol', unreadCount: 0, mentionCount: 0, isDirect: true, order: 0 }));
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		// M10 W1: the Directory pick. Default: a joined room the room list gets a moment later; `peek` leaves the list alone.
		openDirectory: async (opts?: { term?: string; filter?: 'rooms' | 'people' }) => {
			b.directoryCalls.push(opts);
			const r = b.roomResult.openDirectory;
			if (r instanceof Error) throw r;
			if (r && 'status' in r) return r;
			const roomId = r?.roomId ?? '!directory:example.org';
			if (r?.peek) return { status: 'done' as const, roomId, peek: true };
			if (!rooms.some((x) => x.id === roomId)) {
				rooms.push(base({ id: roomId, name: 'Directory room', unreadCount: 0, mentionCount: 0, isDirect: false, order: rooms.length }));
				b.emit({ kind: 'rooms' });
			}
			return { status: 'done' as const, roomId };
		},
		// M11 Y4: the direct chat with a user. Default: a DM the room list gets a moment later (an existing one is left as it is).
		startDm: async (userId: string, fromRoomId?: string) => {
			b.dmCalls.push(userId);
			b.dmFromRooms.push(fromRoomId);
			const r = b.roomResult.startDm;
			if (r instanceof Error) throw r;
			if (r && 'status' in r) return r;
			const roomId = r?.roomId ?? `!dm-${userId.split(':')[0].replace(/^@/, '')}:example.org`;
			if (!rooms.some((x) => x.id === roomId)) {
				rooms.unshift(base({ id: roomId, name: userId, unreadCount: 0, mentionCount: 0, isDirect: true, order: 0 }));
				b.emit({ kind: 'rooms' });
			}
			return { status: 'done' as const, roomId };
		},
		leave: async (roomId: string) => {
			b.leaves.push(roomId);
			const r = b.roomResult.leave;
			if (r instanceof Error) throw r;
			if (r) return r;
			const at = rooms.findIndex((x) => x.id === roomId);
			if (at >= 0) rooms.splice(at, 1);
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		// A8: records the room; Element's picker and confirm are the host's, so a result is a cancel or an error.
		upload: async (roomId: string, files?: File[]) => {
			b.uploads.push(roomId);
			b.uploadFiles.push(files?.map((f) => f.name));
			if (b.uploadResult instanceof Error) throw b.uploadResult;
			return b.uploadResult ?? { status: 'done' as const, roomId };
		},
		// A9: counts the call; Element's dialog is the host's, so a result is a cancel or an error (the real one never returns done).
		logout: async () => {
			b.logouts++;
			if (b.logoutResult instanceof Error) throw b.logoutResult;
			return b.logoutResult ?? { status: 'done' as const };
		},
		// M10 W4: counts the open; Element's settings dialog is the host's, so a result is an error (or done when it closes).
		openUserSettings: async (opts?: { tab?: ViewSettingsTab }) => {
			b.userSettingsOpens++;
			b.userSettingsTabs.push(opts?.tab);
			if (b.userSettingsResult) throw b.userSettingsResult;
			return { status: 'done' as const };
		},
		// M10 W6: records the option, then the setting reads it back and `me` fires (a failing store throws instead).
		setRoomSort: async (option: 'recent' | 'alphabetical') => {
			b.sortCalls.push(option);
			if (b.sortResult) throw b.sortResult;
			b.roomSort = option;
			b.emit({ kind: 'me' });
			return { status: 'done' as const };
		},
		// A10: the room item actions record the call, change the room like the host would, or reject with `itemFail`.
		markUnread: async (roomId: string) => {
			b.itemCalls.push(['markUnread', roomId]);
			if (b.itemFail) throw b.itemFail;
			const r = rooms.find((x) => x.id === roomId);
			if (r) {
				r.canMarkAsUnread = false;
				r.showsUnread = true;
			}
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		setFavourite: async (roomId: string, on: boolean) => {
			b.itemCalls.push(['setFavourite', roomId, String(on)]);
			if (b.itemFail) throw b.itemFail;
			const r = rooms.find((x) => x.id === roomId);
			if (r) r.isFavourite = on;
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		// M6 B1: the custom sections a spec lists, and the two actions (the fixture applies a move like the host: the room's section follows).
		sectionList: [] as ViewSection[],
		sections: () => b.sectionList,
		setSection: async (roomId: string, tag: string | null) => {
			b.itemCalls.push(['setSection', roomId, String(tag)]);
			if (b.itemFail) throw b.itemFail;
			const r = rooms.find((x) => x.id === roomId);
			if (r) {
				if (tag === null) delete r.section;
				else {
					r.section = tag;
					r.isFavourite = false;
				}
			}
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		createSectionResult: { section: 'element.io.section.new' } as { status: 'cancelled' } | Error | { section: string },
		createSection: async (roomId?: string) => {
			b.itemCalls.push(['createSection', String(roomId)]);
			if (b.itemFail) throw b.itemFail;
			const result = b.createSectionResult;
			if (result instanceof Error) throw result;
			if ('status' in result) return result;
			b.sectionList = [...b.sectionList, { tag: result.section, name: 'New', order: b.sectionList.length }];
			const r = rooms.find((x) => x.id === roomId);
			if (r) r.section = result.section;
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, section: result.section, ...(roomId ? { roomId } : {}) };
		},
		// M10 W2/W3: the two section actions, the fixture answers like the host: an unknown tag is `failed`; a rename keeps the tag; a
		// removed section leaves the list and its rooms lose `section` (N6: the host snapshot omits a tag not in the ordered sections).
		editSectionResult: { name: 'Renamed' } as { status: 'cancelled' } | Error | { name: string },
		editSection: async (tag: string) => {
			b.itemCalls.push(['editSection', tag]);
			if (b.itemFail) throw b.itemFail;
			if (!b.sectionList.some((s) => s.tag === tag)) throw Object.assign(new Error(`the section ${tag} is not listed`), { code: 'failed' });
			const result = b.editSectionResult;
			if (result instanceof Error) throw result;
			if ('status' in result) return result;
			b.sectionList = b.sectionList.map((s) => (s.tag === tag ? { ...s, name: result.name } : s));
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, section: tag };
		},
		removeSectionResult: { removed: true } as { status: 'cancelled' } | Error | { removed: true },
		removeSection: async (tag: string) => {
			b.itemCalls.push(['removeSection', tag]);
			if (b.itemFail) throw b.itemFail;
			if (!b.sectionList.some((s) => s.tag === tag)) throw Object.assign(new Error(`the section ${tag} is not listed`), { code: 'failed' });
			const result = b.removeSectionResult;
			if (result instanceof Error) throw result;
			if ('status' in result) return result;
			b.sectionList = b.sectionList.filter((s) => s.tag !== tag);
			for (const r of rooms) if (r.section === tag) delete r.section;
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, section: tag };
		},
		// M11 Y3: Element's section reorder (`RoomListStoreV3.reorderSection`): one step, up or down, over the sections as `sections()` lists them (by
		// `order`). An unknown tag or an edge (first up, last down) is `failed`; a refused write is `b.itemFail` with code `failed`, a store timeout / lagging `sections()` is `b.itemFail` with code `network` (N10).
		moveSection: async (tag: string, direction: 'up' | 'down') => {
			b.itemCalls.push(['moveSection', tag, direction]);
			if (b.itemFail) throw b.itemFail;
			const sorted = [...b.sectionList].sort((a, c) => a.order - c.order);
			const i = sorted.findIndex((s) => s.tag === tag);
			const j = direction === 'up' ? i - 1 : i + 1;
			if (i < 0) throw Object.assign(new Error(`the section ${tag} is not listed`), { code: 'failed' });
			if (j < 0 || j >= sorted.length) throw Object.assign(new Error(`the section ${tag} has no neighbour to move ${direction}`), { code: 'failed' });
			[sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
			b.sectionList = sorted.map((s, order) => ({ ...s, order }));
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, section: tag };
		},
		setNotificationLevel: async (roomId: string, level: ViewNotificationLevel) => {
			b.itemCalls.push(['setNotificationLevel', roomId, level]);
			if (b.itemFail) throw b.itemFail;
			const r = rooms.find((x) => x.id === roomId);
			if (r) r.notificationLevel = level;
			b.emit({ kind: 'rooms' });
			return { status: 'done' as const, roomId };
		},
		react: async (roomId: string, eventId: string, key: string) => {
			b.reacts.push([roomId, eventId, key]);
			return { status: 'done' as const, roomId, eventId };
		},
		// M13 U6 (bridge version 7): the host picks the target itself; the fixture only records the press (room, key).
		quickReact: async (roomId: string, key: string) => {
			b.quickReacts.push([roomId, key]);
			if (b.quickReactResult) throw b.quickReactResult;
			return { status: 'done' as const, roomId };
		},
		download: async (roomId: string, eventId: string) => {
			b.downloads.push([roomId, eventId]);
			if (b.downloadResult) throw b.downloadResult;
			return { status: 'done' as const, roomId, eventId };
		},
		// M12 Z3 (bridge version 6): a hidden image flips to visible in the next timeline snapshot; an unknown event is refused before any change.
		showMedia: async (roomId: string, eventId: string) => {
			b.mediaReveals.push([roomId, eventId]);
			if (b.showMediaResult) throw b.showMediaResult;
			const found = (timelines[roomId] ?? []).find((m) => m.id === eventId);
			if (!found) throw Object.assign(new Error('unknown event'), { code: 'unknown_event' });
			if (found.media?.state === 'hidden') {
				timelines[roomId] = (timelines[roomId] ?? []).map((m) =>
					m.id === eventId ? { ...m, body: 'revealed.png', media: { kind: found.media!.kind, state: 'ready' as const, url: 'http://hs/revealed.png', name: 'revealed.png' } } : m,
				);
				b.emit({ kind: 'timeline', roomId });
			}
			return { status: 'done' as const, roomId, eventId };
		},
		openReactionPicker: async (roomId: string, eventId: string) => {
			b.pickers.push([roomId, eventId]);
			return { status: 'done' as const, roomId, eventId };
		},
		openForward: async (roomId: string, eventId: string) => {
			b.forwards.push([roomId, eventId]);
			if (b.forwardResult) throw b.forwardResult;
			return { status: 'done' as const, roomId: b.forwardJump ?? roomId, eventId };
		},
		openViewSource: async (roomId: string, eventId: string) => {
			b.viewSources.push([roomId, eventId]);
			if (b.viewSourceResult) throw b.viewSourceResult;
			return { status: 'done' as const, roomId, eventId };
		},
		openThread: async (roomId: string, eventId: string) => {
			b.threads.push([roomId, eventId]);
			if (b.threadResult) throw b.threadResult;
			return { status: 'done' as const, roomId, eventId };
		},
		closeThread: () => {
			b.threadCloses += 1;
		},
		openPanel: async (roomId: string, card: string) => {
			b.panels.push([roomId, card]);
			if (b.panelResult) throw b.panelResult;
			return { status: 'done' as const, roomId };
		},
		// M14 K4 (bridge version 8): the fixture only records (room, user).
		openUserInfo: async (roomId: string, userId: string) => {
			b.userInfos.push([roomId, userId]);
			if (b.userInfoResult) throw b.userInfoResult;
			return { status: 'done' as const, roomId };
		},
		// M14 K6 (bridge version 8): the fixture only records (room, event).
		copyMarkdown: async (roomId: string, eventId: string) => {
			b.copyMarkdowns.push([roomId, eventId]);
			if (b.copyMarkdownResult) throw b.copyMarkdownResult;
			return { status: 'done' as const, roomId, eventId };
		},
		closePanel: () => {
			b.panelCloses += 1;
		},
		onJump: (cb: Parameters<ClientViewBridge['onJump']>[0]) => {
			jumpListeners.add(cb);
			return () => void jumpListeners.delete(cb);
		},
		onRoomOpen: (cb: Parameters<ClientViewBridge['onRoomOpen']>[0]) => {
			roomOpenListeners.add(cb);
			return () => void roomOpenListeners.delete(cb);
		},
		emitJump: (j: { roomId: string; eventId: string }) => jumpListeners.forEach((cb) => cb(j)),
		// M12 Z4: the room's `m.room.encryption` entry (id `$enc:<roomId>`, kind other, empty body) set to a state, or removed with
		// `undefined`; a `timeline` event follows, as the host sends when the view-model refreshes the state.
		encryption: (roomId: string, state: NonNullable<ViewMessage['encryption']>['state'] | undefined, userName?: string) => {
			const id = `$enc:${roomId}`;
			const others = (timelines[roomId] ?? []).filter((m) => m.id !== id);
			const entry: ViewMessage[] = state ? [{ id, roomId, senderId: '@alice:example.org', senderName: 'Alice', body: '', ts: ago(30), kind: 'other', encryption: { state, ...(userName ? { userName } : {}) } }] : [];
			timelines[roomId] = [...entry, ...others];
			b.emit({ kind: 'timeline', roomId });
		},
		// M4 (D15): a retention notice entry (kind other, empty body, `retention.text` as the host sends it), added or replaced.
		retention: (roomId: string, id: string, text: string) => {
			const entry: ViewMessage = { id, roomId, senderId: '@alice:example.org', senderName: 'Alice', body: '', ts: ago(20), kind: 'other', retention: { text } };
			timelines[roomId] = [...(timelines[roomId] ?? []).filter((m) => m.id !== id), entry];
			b.emit({ kind: 'timeline', roomId });
		},
		// M4 (D15): the message's lifetime ran out: the host's stub (empty body, no sender name, `expired`) replaces it.
		expire: (roomId: string, id: string) => {
			const old = (timelines[roomId] ?? []).find((m) => m.id === id);
			const stub: ViewMessage = { id, roomId, senderId: old?.senderId ?? '', senderName: '', ts: old?.ts ?? ago(10), body: '', kind: 'other', expired: true };
			timelines[roomId] = [...(timelines[roomId] ?? []).filter((m) => m.id !== id), stub];
			b.emit({ kind: 'timeline', roomId });
		},
		emitRoomOpen: (j: { roomId: string; eventId?: string }) => roomOpenListeners.forEach((cb) => cb(j)),
		openReport: async (roomId: string, eventId: string) => {
			b.reports.push([roomId, eventId]);
			return { status: 'done' as const, roomId, eventId };
		},
		loadOlder: async (roomId: string) => {
			b.olderCalls.push(roomId);
			const page = b.olderPages[roomId]?.shift() ?? [];
			timelines[roomId] = [...page, ...(timelines[roomId] ?? [])];
			if (page.length > 0) b.emit({ kind: 'timeline', roomId });
			return { added: page.length, ids: page.map((m) => m.id), atStart: (b.olderPages[roomId]?.length ?? 0) === 0, atLimit: false, ...b.olderResult };
		},
		onChange: (cb: Parameters<ClientViewBridge['onChange']>[0]) => {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		emit: (e: Parameters<Parameters<ClientViewBridge['onChange']>[0]>[0]) => listeners.forEach((cb) => cb(e)),
	};
	return b;
};
