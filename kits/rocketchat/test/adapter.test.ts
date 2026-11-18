// Adapter unit tests (H5): mapping, the sdk seam (mapped answered, unmapped rejected + recorded), Meteor stub, reload
// path parsing, bridge lookup. Run: node --test kits/rocketchat/test/ (Node >= 22.18 strips the types).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';

// A minimal window before any module that reads it at load: the kit document at /kits/rocketchat/index.html,
// not framed (window.parent === window), the host's bridge on it.
const bridge = fixtureBridge();
const win: Record<string, unknown> = {
	location: { pathname: '/kits/rocketchat/index.html', hash: '', origin: 'http://localhost', search: '' },
	history: {},
	localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
	__clientViewBridge: bridge,
};
win.parent = win;
Object.assign(globalThis, { window: win });

const { BridgeSource, forwardFailure, CANNOT_FORWARD, threadFailure, CANNOT_THREAD, DIALOG_BUSY, isDialogBusy, moveFailure, CANNOT_MOVE, MOVE_NOT_SAVED } = await import('../src/adapter/source.ts');
const { DISPLAY_NAME_SETTINGS, toVideoConference, parseQuotes, roomPath, messageLink, mediaAttachment, downloadHref, parseDownloadHref, e2eFields, isNoMessageEvent, urlsOf, idHash, loginToken, slug, slugs, setReactionName, setReactionUnicode, shortcodesToUnicode, reactionKeyFor, newOwnReactionNames, syncAnswer, threadFields, toMessage, encryptionLine, toSubscription, toUser, sidebarCategories, notificationLevelOf } = await import('../src/adapter/map.ts');
const { stubLog, answeredLog } = await import('../src/adapter/recorder.ts');
const { findBridge, getSource, supportedBridgeVersion } = await import('../src/adapter/bridge.ts');
const { sdk, setCachedIds, setJumpFailed, setRestoreComposer, setRoomOpener, routeShowsRoom, openPreview } = await import('../src/adapter/sdk.ts');
const { Meteor } = await import('../src/meteor-stub.ts');
const { parseHash } = await import('../src/reload.ts');
const { restoredText, restoreComposerText, settledPath, composerHolds, saveRoomDraft } = await import('../src/composer-restore.ts');
const { wiring } = await import('../src/adapter/wiring.ts');

const GENERAL = '!general:example.org';
const RANDOM = '!random:example.org';

describe('mapping', () => {
	it('sidebar names: fname = the room list display name, name = a route slug, and the RC settings that show fname', () => {
		const src = new BridgeSource(fixtureBridge());
		const sub = src.subscriptions().find((s) => s.rid === GENERAL)!;
		const room = src.rooms().find((r) => r._id === GENERAL)!;
		assert.equal(sub.fname, 'General Chat');
		assert.equal(sub.name, `general-chat-${idHash(GENERAL)}`);
		assert.equal(room.fname, 'General Chat');
		assert.equal(DISPLAY_NAME_SETTINGS.UI_Allow_room_names_with_special_chars, true);
		assert.equal(DISPLAY_NAME_SETTINGS.UI_Use_Real_Name, true);
		assert.equal(slug('Ünïcode Room!!'), 'unicode-room');
		assert.equal(slug('🎉'), 'room');
	});

	it('a slug stays on its room when the list reorders and when an alike-named room joins or leaves (room-id hash)', () => {
		const room = (id: string, order: number) =>
			({ id, name: 'Team', unreadCount: 0, mentionCount: 0, isDirect: false, order }) as const;
		const before = slugs([room('!b:x', 0), room('!a:x', 1)]);
		const after = slugs([room('!a:x', 0), room('!b:x', 1)]);
		assert.deepEqual([...before.entries()].sort(), [...after.entries()].sort());
		assert.notEqual(after.get('!a:x'), after.get('!b:x'));
		// '!a:x' sorts first: with a rank suffix, leaving it would hand its slug to '!b:x' and retarget a stale route.
		assert.equal(slugs([room('!b:x', 0)]).get('!b:x'), after.get('!b:x'));
		assert.equal(slugs([room('!c:x', 0), room('!b:x', 1)]).get('!b:x'), after.get('!b:x'));
		assert.match(after.get('!a:x')!, /^team-[0-9a-z]{6}$/);
	});

	it('a read room is seen since the kit saw it read, not at its order time (no divider in a read room, F3)', () => {
		const me = { userId: '@me:x', displayName: 'Me' };
		const epoch = Date.UTC(2026, 9, 21, 12);
		const read = { id: '!r:x', name: 'R', unreadCount: 0, mentionCount: 0, isDirect: false, order: 5 } as const;
		// A message 1 minute before load is read: `ls` must not sit before it (the order time was epoch - 5 min).
		assert.ok(toSubscription(read, 'r', me as never, epoch).ls.getTime() >= epoch - 60_000);
		assert.equal(toSubscription(read, 'r', me as never, epoch, epoch + 1000).ls.getTime(), epoch + 1000);
		assert.equal(toSubscription({ ...read, unreadCount: 2 }, 'r', me as never, epoch).ls.getTime(), 0);
	});

	it('the login token names the Matrix user, so another user never reuses the cache', () => {
		assert.notEqual(loginToken('@alice:x'), loginToken('@bob:x'));
		assert.equal(loginToken('@alice:x'), loginToken('@alice:x'));
	});

	it('a since sync removes every cached id the snapshot lacks, with _deletedAt', () => {
		const now = new Date(5);
		const answer = syncAnswer([{ _id: 'a' }, { _id: 'b' }], ['a', 'gone', 'b', 'left'], now);
		assert.deepEqual(answer.update, [{ _id: 'a' }, { _id: 'b' }]);
		assert.deepEqual(answer.remove, [
			{ _id: 'gone', _deletedAt: now },
			{ _id: 'left', _deletedAt: now },
		]);
	});

	it('direct rooms are type d, unread and mention counts carry over, order becomes descending lm', () => {
		const src = new BridgeSource(fixtureBridge(), 1_000_000_000);
		const subs = src.subscriptions();
		const random = subs.find((s) => s.rid === RANDOM)!;
		assert.equal(random.unread, 1);
		assert.equal(random.userMentions, 1);
		assert.equal(random.alert, true);
		assert.equal(subs.find((s) => s.rid === '!bob:example.org')!.t, 'd');
		const lm = (id: string) => +src.rooms().find((r) => r._id === id)!.lm!;
		assert.ok(lm(GENERAL) > lm(RANDOM));
	});

	it('an emoji-only body stays a non-empty string', () => {
		const src = new BridgeSource(fixtureBridge());
		const msg = src.history(GENERAL).find((m) => m._id === '$m2')!;
		assert.equal(msg.msg, '🎉');
		assert.equal(toMessage({ ...bridge.timeline(GENERAL)[1], body: undefined as unknown as string }).msg, '');
	});

	it('history is oldest first with the sender as user', () => {
		const src = new BridgeSource(fixtureBridge());
		const h = src.history(GENERAL);
		assert.deepEqual(
			h.map((m) => m._id),
			['$m1', '$m2'],
		);
		assert.equal(src.user('@bob:example.org')?.name, 'Bob');
		assert.equal(src.user('@alice:example.org')?.name, 'Alice');
		assert.equal(src.user('@nobody:example.org'), undefined);
	});

	it('avatars: the view-model URL when there is one, an inline initial otherwise (never an /avatar/ route)', () => {
		const src = new BridgeSource(fixtureBridge());
		assert.equal(src.avatar(RANDOM), 'https://example.org/_matrix/media/v3/thumbnail/random');
		const fallback = src.avatar(GENERAL);
		assert.match(fallback, /^data:image\/svg\+xml/);
		assert.match(decodeURIComponent(fallback), />G</);
		assert.doesNotMatch(src.avatar('@bob:example.org'), /\/avatar\//);
	});
});

describe('E2EE signals (REQ-0007 V3, kit half)', () => {
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over });

	it('a failed message is Rocket.Chat\'s encrypted placeholder, no body, and the reason as the warning', () => {
		const doc = toMessage(base({ body: '', e2e: { state: 'failed', text: 'Unable to decrypt message' } })) as unknown as Record<string, unknown>;
		assert.equal(doc.t, 'e2e');
		assert.equal(doc.e2e, 'pending');
		assert.equal(doc.msg, '');
		assert.equal(doc.e2eWarning, 'Unable to decrypt message');
	});

	it('a failed message never carries a body, even if the bridge sent one', () => {
		const doc = toMessage(base({ body: '** Unable to decrypt: DecryptionError **', e2e: { state: 'failed', text: 'x' } }));
		assert.equal(doc.msg, '');
	});

	it('a pending message is the placeholder without a warning when it has no text', () => {
		const doc = toMessage(base({ body: '', e2e: { state: 'pending', text: '' } })) as unknown as Record<string, unknown>;
		assert.deepEqual([doc.t, doc.e2e, doc.msg, 'e2eWarning' in doc], ['e2e', 'pending', '', false]);
	});

	it('a decrypted message with a padlock warning keeps its text and carries the warning, without Rocket.Chat\'s e2e type (which would hide it)', () => {
		const doc = toMessage(base({ e2e: { state: 'decrypted', warning: 'Encrypted by a device not verified by its owner.' } })) as unknown as Record<string, unknown>;
		assert.deepEqual([doc.t, doc.e2e, doc.msg, doc.e2eWarning], [undefined, undefined, 'Hello **world**, this is _markdown_', 'Encrypted by a device not verified by its owner.']);
	});

	it('a decrypted message without a warning, and a message without e2e, stay plain (no t, no e2e, no warning)', () => {
		for (const e2e of [{ state: 'decrypted' }, undefined]) {
			const doc = toMessage(base({ e2e })) as unknown as Record<string, unknown>;
			assert.deepEqual([doc.t, doc.e2e, 'e2eWarning' in doc], [undefined, undefined, false]);
		}
	});

	it('maps every e2e state', () => {
		assert.deepEqual(e2eFields(undefined), {});
		assert.deepEqual(e2eFields({ state: 'decrypted' }), {});
		assert.deepEqual(e2eFields({ state: 'decrypted', warning: 'w' }), { e2eWarning: 'w' });
		assert.deepEqual(e2eFields({ state: 'failed', text: 't' }), { t: 'e2e', e2e: 'pending', e2eWarning: 't' });
		assert.deepEqual(e2eFields({ state: 'pending', text: '' }), { t: 'e2e', e2e: 'pending' });
	});

	it('a warning that arrives later re-renders the row', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const changes: string[] = [];
		src.onChange((c) => changes.push(`${c.kind}:${c.op}:${(c.doc as { _id: string })._id}`));
		b.timeline(GENERAL)[0].e2e = { state: 'decrypted', warning: 'w' };
		b.emit({ kind: 'timeline', roomId: GENERAL });
		assert.deepEqual(changes, ['message:changed:$m1']);
	});
});

describe('replies (increment 1)', () => {
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over });
	const reply = { eventId: '$p', senderId: '@bob:example.org', senderName: 'Bob', text: 'Lunch at noon' };

	it('a reply carries Rocket.Chat\'s quote attachment: author, jump link into the room, plain text', () => {
		const doc = toMessage(base({ replyTo: reply }), { _id: GENERAL, t: 'c', name: 'general-x1' } as never) as unknown as {
			attachments: Array<Record<string, string>>;
		};
		assert.equal(doc.attachments.length, 1);
		const [q] = doc.attachments;
		assert.equal(q.author_name, 'Bob');
		assert.equal(q.text, 'Lunch at noon');
		assert.equal(q.message_link, '/channel/general-x1?msg=%2524p');
		assert.match(q.author_icon, /^data:image\/svg\+xml/);
	});

	it('a reply in a direct room links to the direct route; a message without a reply has no attachments', () => {
		const doc = toMessage(base({ replyTo: reply }), { _id: '!bob:example.org', t: 'd', name: 'bob' } as never) as unknown as {
			attachments: Array<Record<string, string>>;
		};
		assert.equal(doc.attachments[0].message_link, '/direct/!bob%3Aexample.org?msg=%2524p');
		assert.equal('attachments' in (toMessage(base()) as object), false);
	});

	it('the source hands the room to the quote, and a quote that arrives later re-renders the row', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		const [first] = b.timeline(GENERAL);
		first.replyTo = reply;
		b.emit({ kind: 'timeline', roomId: GENERAL });
		const doc = changes.find((c) => c.kind === 'message')?.doc as { attachments: Array<{ message_link: string }> };
		assert.ok(doc, 'the row with its new quote is a change');
		assert.match(doc.attachments[0].message_link, /^\/channel\/[^?]+-[0-9a-z]+\?msg=%2524p$/);
	});

	// grok kit F3 (inc1): a rename changes the slug, so loaded quotes must follow it without a timeline update.
	it('a room rename re-links the quotes of its loaded messages', () => {
		const b = fixtureBridge();
		const [first] = b.timeline(GENERAL);
		first.replyTo = reply;
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		b.rooms().find((r) => r.id === GENERAL)!.name = 'Team Dinner';
		b.emit({ kind: 'rooms' });
		const doc = changes.find((c) => c.kind === 'message')?.doc as { attachments: Array<{ message_link: string }> };
		assert.ok(doc, 'the quoted row is a change');
		assert.match(doc.attachments[0].message_link, /^\/channel\/team-dinner-[0-9a-z]+\?msg=%2524p$/);
	});

	// M9 Q1 / F1: the quote jumps to the id the kit renders the quoted message under (a sent message shows under its Rocket.Chat id).
	it('a quote links the id the kit renders the quoted message under', () => {
		const m = { ...fixtureBridge().timeline(GENERAL)[0], replyTo: reply };
		const mapped = toMessage(m, undefined, (id) => (id === '$p' ? 'rc-p1' : id));
		assert.match((mapped.attachments?.[0] as { message_link: string }).message_link, /\?msg=rc-p1$/);
		assert.match((toMessage(m).attachments?.[0] as { message_link: string }).message_link, /\?msg=%2524p$/);
	});

	// grok kit F2 (inc1): Rocket.Chat's jump reads the message by id (chat.getMessage) before it scrolls to it.
	it('a loaded message is found by id alone; an unknown id is not', () => {
		const src = new BridgeSource(fixtureBridge());
		src.history(GENERAL);
		assert.equal(src.message('$m2')?._id, '$m2');
		assert.equal(src.message('$nope'), undefined);
	});
});

describe('reactions (increment 2)', () => {
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over });
	const thumbs = { key: '👍', count: 2, mine: true, senderIds: ['@bob:example.org', '@me:example.org'] };
	const party = { key: '🎉', count: 1, mine: false, senderIds: ['@bob:example.org'] };

	it('reactions are Rocket.Chat\'s reactions field: keyed by emoji name, the senders as usernames', () => {
		setReactionName((key) => ({ '👍': ':thumbsup:', '🎉': ':tada:' })[key] ?? key);
		try {
			const doc = toMessage(base({ reactions: [thumbs, party] })) as unknown as { reactions: Record<string, { usernames: string[] }> };
			assert.deepEqual(doc.reactions, {
				':thumbsup:': { usernames: ['@bob:example.org', '@me:example.org'] },
				':tada:': { usernames: ['@bob:example.org'] },
			});
		} finally {
			setReactionName((key) => key);
		}
	});

	it('keys that share one emoji name merge their senders; a key without a name stays; no reactions, no field', () => {
		setReactionName((key) => (key.startsWith('👍') ? ':thumbsup:' : key));
		try {
			const doc = toMessage(
				base({ reactions: [thumbs, { ...party, key: '👍\uFE0F', senderIds: ['@carol:example.org', '@bob:example.org'] }, { ...party, key: 'lol' }] }),
			) as unknown as { reactions: Record<string, { usernames: string[] }> };
			assert.deepEqual(doc.reactions, {
				':thumbsup:': { usernames: ['@bob:example.org', '@me:example.org', '@carol:example.org'] },
				'lol': { usernames: ['@bob:example.org'] },
			});
		} finally {
			setReactionName((key) => key);
		}
		assert.equal('reactions' in (toMessage(base()) as object), false);
		assert.equal('reactions' in (toMessage(base({ reactions: [] })) as object), false);
	});

	it('a reaction that arrives later re-renders the row', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		b.timeline(GENERAL)[0].reactions = [party];
		b.emit({ kind: 'timeline', roomId: GENERAL });
		const doc = changes.find((c) => c.kind === 'message')?.doc as { reactions: Record<string, unknown> };
		assert.ok(doc?.reactions?.['🎉'], 'the row with its new reaction is a change');
	});
});

describe('thread summary (increment 3)', () => {
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over });
	const thread = {
		replyCount: 2,
		lastReplyTs: Date.UTC(2026, 9, 21, 12, 30),
		lastReply: { eventId: '$r2', senderId: '@carol:example.org', text: 'Count me in' },
		participantIds: ['@bob:example.org', '@carol:example.org'],
	};

	it('a thread summary is Rocket.Chat\'s thread-main-message fields: tcount, tlm (a Date) and replies (participant ids)', () => {
		const doc = toMessage(base({ thread })) as unknown as { tcount: number; tlm: Date; replies: string[] };
		assert.equal(doc.tcount, 2);
		assert.ok(doc.tlm instanceof Date);
		assert.equal(doc.tlm.getTime(), thread.lastReplyTs);
		assert.deepEqual(doc.replies, ['@bob:example.org', '@carol:example.org']);
		// The latest reply's text has no Rocket.Chat field: it stays out of the message.
		assert.equal(JSON.stringify(doc).includes('Count me in'), false);
	});

	it('no thread, or no reply, no thread fields (they would mark a main message with an empty summary)', () => {
		for (const doc of [toMessage(base()), toMessage(base({ thread: { ...thread, replyCount: 0 } }))]) {
			for (const field of ['tcount', 'tlm', 'replies']) assert.equal(field in (doc as object), false);
		}
		assert.deepEqual(threadFields(base()), {});
	});

	it('a reply that arrives later re-renders the root', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		b.timeline(GENERAL)[0].thread = thread;
		b.emit({ kind: 'timeline', roomId: GENERAL });
		const doc = changes.find((c) => c.kind === 'message')?.doc as { tcount: number };
		assert.equal(doc?.tcount, 2, 'the root with its new summary is a change');
	});
});

describe('changes', () => {
	it('markRead goes to the bridge and the room update clears unread in the subscription', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const changes: string[] = [];
		src.onChange((c) => changes.push(`${c.kind}:${c.op}:${(c.doc as { unread?: number }).unread ?? '-'}`));
		src.markRead(RANDOM);
		assert.deepEqual(b.reads, [RANDOM]);
		assert.ok(changes.includes('subscription:changed:0'), changes.join());
		assert.equal(src.subscriptions().find((s) => s.rid === RANDOM)!.unread, 0);
	});

	it('a left room is removed; a new timeline message is a change; a message leaving the window is not a delete', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const changes: string[] = [];
		src.onChange((c) => changes.push(`${c.kind}:${c.op}:${(c.doc as { _id: string })._id}`));
		b.rooms().splice(2, 1);
		b.emit({ kind: 'rooms' });
		assert.ok(changes.includes('room:removed:!bob:example.org'));
		assert.ok(changes.includes('subscription:removed:s-!bob:example.org'));
		const tl = b.timeline(GENERAL);
		tl.push({ ...tl[0], id: '$m9', body: 'new', ts: Date.now() });
		tl.shift();
		b.emit({ kind: 'timeline', roomId: GENERAL });
		assert.ok(changes.includes('message:changed:$m9'));
		assert.ok(!changes.some((c) => c.startsWith('message:removed')));
	});

	it('a sender avatar that arrives later re-renders that sender\'s earlier rows (grok kit F3)', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const changes: string[] = [];
		src.onChange((c) => changes.push(`${c.kind}:${c.op}:${(c.doc as { _id: string })._id}`));
		const tl = b.timeline(GENERAL);
		const sender = tl[0].senderId;
		for (const m of tl) if (m.senderId === sender) m.senderAvatarUrl = 'mxc-thumb://late';
		b.emit({ kind: 'timeline', roomId: GENERAL });
		assert.deepEqual(
			changes,
			tl.filter((m) => m.senderId === sender).map((m) => `message:changed:${m.id}`),
		);
		b.emit({ kind: 'timeline', roomId: GENERAL });
		assert.equal(changes.length, tl.filter((m) => m.senderId === sender).length, 'no change, no re-render');
	});

	it('connection changes reach listeners', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const seen: string[] = [];
		src.onConnection((c) => seen.push(c));
		b.conn = 'offline';
		b.emit({ kind: 'connection' });
		assert.deepEqual(seen, ['offline']);
	});
});

describe('sdk seam', () => {
	beforeEach(() => {
		stubLog.length = 0;
		answeredLog.length = 0;
	});

	it('answers mapped methods and endpoints from the bridge', async () => {
		setCachedIds('subscriptions', () => []);
		const rooms = (await sdk.call('rooms/get')) as { _id: string }[];
		assert.ok(rooms.some((r) => r._id === GENERAL));
		const subs = (await sdk.call('subscriptions/get', new Date())) as { update: unknown[] };
		assert.equal(subs.update.length, 3);
		const hist = (await sdk.rest.get('/v1/rooms.history', { roomId: GENERAL })) as { messages: { _id: string }[] };
		assert.deepEqual(
			hist.messages.map((m) => m._id),
			['$m2', '$m1'],
		);
		assert.deepEqual(answeredLog, ['call rooms/get', 'call subscriptions/get', 'GET /v1/rooms.history']);
		assert.equal(stubLog.length, 0);
	});

	it('since syncs answer removes from the wired Rocket.Chat store ids; unwired is an error', async () => {
		await assert.rejects(sdk.call('rooms/get', new Date()), /cached ids for rooms not wired/);
		setCachedIds('rooms', () => [GENERAL, '!left:example.org']);
		const rooms = (await sdk.call('rooms/get', new Date())) as { update: { _id: string }[]; remove: { _id: string; _deletedAt: Date }[] };
		assert.ok(rooms.update.some((r) => r._id === GENERAL));
		assert.deepEqual(
			rooms.remove.map((r) => r._id),
			['!left:example.org'],
		);
		assert.ok(rooms.remove[0]!._deletedAt instanceof Date);
	});

	it('subscriptions.read -> bridge.markRead', async () => {
		await sdk.rest.post('/v1/subscriptions.read', { rid: RANDOM });
		assert.deepEqual(bridge.reads, [RANDOM]);
		assert.ok(answeredLog.includes('POST /v1/subscriptions.read'));
	});

	describe('chat.react (A2)', () => {
		const emoji: Record<string, string> = { ':thumbsup:': '👍', ':+1:': '👍', ':tada:': '🎉' };
		const MID = '$m1';
		beforeEach(() => {
			setReactionName((key) => (key.startsWith('👍') ? ':thumbsup:' : key === '🎉' ? ':tada:' : key));
			setReactionUnicode((name) => emoji[name]);
			getSource().history(GENERAL);
			bridge.reacts.length = 0;
		});
		afterEach(() => {
			setReactionName((key) => key);
			setReactionUnicode(() => undefined);
			delete (bridge.timeline(GENERAL).find((m) => m.id === MID) as { reactions?: unknown }).reactions;
		});

		it('maps the emoji name (emoji or reaction field, with or without colons) to the Matrix key and presses it', async () => {
			assert.deepEqual(await sdk.rest.post('/v1/chat.react', { messageId: MID, emoji: ':tada:' }), { success: true });
			await sdk.rest.post('/v1/chat.react', { messageId: MID, reaction: ':thumbsup:' });
			await sdk.rest.post('/v1/chat.react', { messageId: MID, reaction: 'tada' });
			assert.deepEqual(bridge.reacts, [
				[GENERAL, MID, '🎉'],
				[GENERAL, MID, '👍'],
				[GENERAL, MID, '🎉'],
			]);
			assert.ok(answeredLog.includes('POST /v1/chat.react'));
			assert.equal(stubLog.length, 0);
		});

		it('presses the key the message already carries (another variation selector, a text key)', () => {
			const m = { ...bridge.timeline(GENERAL)[0], reactions: [{ key: '👍\uFE0F', count: 1, mine: false, senderIds: [] }, { key: 'lol', count: 1, mine: false, senderIds: [] }] };
			assert.equal(reactionKeyFor(m, ':thumbsup:'), '👍\uFE0F');
			assert.equal(reactionKeyFor(m, ':+1:'), '👍\uFE0F');
			assert.equal(reactionKeyFor(m, 'lol'), 'lol');
			assert.equal(reactionKeyFor(m, ':tada:'), '🎉');
		});

		it('merged keys (one chip): the user\'s own key is the one pressed, else the order', () => {
			const base = bridge.timeline(GENERAL)[0];
			const other = { key: '\u2764', count: 1, mine: false, senderIds: ['@bob:example.org'] };
			const own = { key: '\u2764\uFE0F', count: 1, mine: true, senderIds: ['@me:example.org'] };
			setReactionName((key) => (key.replace(/\uFE0F/g, '') === '\u2764' ? ':heart:' : key));
			setReactionUnicode((name) => (name === ':heart:' ? '\u2764\uFE0F' : undefined));
			assert.equal(reactionKeyFor({ ...base, reactions: [other, own] }, ':heart:'), '\u2764\uFE0F');
			assert.equal(reactionKeyFor({ ...base, reactions: [own, other] }, 'heart'), '\u2764\uFE0F');
			assert.equal(reactionKeyFor({ ...base, reactions: [other, { ...own, mine: false }] }, ':heart:'), '\u2764');
		});

		it('newOwnReactionNames: a first reaction on an actionable message with none counts; reactions that reappear after a view that could not carry them do not', () => {
			const base = bridge.timeline(GENERAL)[0];
			const names: Record<string, string> = { '\u{1F389}': ':tada:', '\u2764\uFE0F': ':heart:' };
			setReactionName((key) => names[key] ?? key);
			const mine = (key: string) => ({ key, count: 1, mine: true, senderIds: ['@me:example.org'] });
			const plain = { ...base, reactions: undefined, redacted: undefined, e2e: undefined };
			const withBoth = { ...base, reactions: [mine('\u{1F389}'), mine('\u2764\uFE0F')] };
			// the first reaction on a message that had none (decrypted or without e2e marks) is recorded, in view order
			assert.deepEqual(newOwnReactionNames(plain, withBoth), ['tada', 'heart']);
			assert.deepEqual(newOwnReactionNames({ ...plain, e2e: { state: 'decrypted' } }, withBoth), ['tada', 'heart']);
			// a reaction already in the previous view is not new
			assert.deepEqual(newOwnReactionNames({ ...base, reactions: [mine('\u{1F389}')] }, withBoth), ['heart']);
			// not actionable before (no chips shown): the reactions that reappear are old ones
			assert.deepEqual(newOwnReactionNames({ ...plain, e2e: { state: 'pending', text: 'Waiting for this message' } }, withBoth), []);
			assert.deepEqual(newOwnReactionNames({ ...plain, e2e: { state: 'failed', text: 'Unable to decrypt' } }, withBoth), []);
			assert.deepEqual(newOwnReactionNames({ ...plain, redacted: true }, withBoth), []);
			// and after it decrypts, a reaction made later is new again
			assert.deepEqual(newOwnReactionNames({ ...base, e2e: { state: 'decrypted' }, reactions: [mine('\u{1F389}')] }, withBoth), ['heart']);
		});

		it('a message that left the snapshot keeps the last view the kit saw, so a press still uses its key', async () => {
			const b = fixtureBridge();
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const list = b.timeline(GENERAL);
			const at = list.findIndex((m) => m.id === MID);
			list[at] = { ...list[at], reactions: [{ key: 'lol', count: 1, mine: true, senderIds: ['@me:example.org'] }] };
			src.history(GENERAL);
			const [gone] = list.splice(at, 1);
			assert.ok(gone);
			assert.equal(b.timeline(GENERAL).some((m) => m.id === MID), false);
			await src.react(MID, 'lol');
			assert.deepEqual(b.reacts, [[GENERAL, MID, 'lol']]);
		});

		// M12 Z4 fix 1 (grok F1): Rocket.Chat's `+:shortcode:` reacts to the newest loaded message (`findLastMessage`, system lines
		// included). Element's quick reaction (SendMessageComposer.sendQuickReaction) walks the live timeline newest first and
		// reacts to the first `m.room.message` event, skipping every other event type; with none it does nothing. The encryption
		// line (`room_e2e_enabled`), the call card (`videoconf`) and a message that is not readable (`e2e`) are rows Rocket.Chat
		// aims the press at. M13 U6: the HOST applies Element's rule (`bridge.quickReact(roomId, key)`), the kit picks no target
		// and sends no `react` for such a press.
		const newestFirst = (rid: string, b = bridge) => b.timeline(rid).filter((m) => !m.encryption && !m.call && !m.e2e);

		it('the encryption system line takes no reaction: `+:tada:` aimed at it goes to the host quick reaction (its rule picks the target), no react on the line, nothing is sent as text', async () => {
			const line = bridge.timeline(GENERAL).find((m) => m.id === `$enc:${GENERAL}`);
			assert.equal(line, undefined, 'the shared fixture has no line before the case');
			bridge.encryption(GENERAL, 'enabled');
			try {
				const enc = bridge.timeline(GENERAL).find((m) => m.id === `$enc:${GENERAL}`)!;
				enc.ts = Date.now() + 60_000; // the newest entry of the room, as the first line of a new encrypted room is
				getSource().history(GENERAL);
				const before = { quick: bridge.quickReacts.length, reacts: bridge.reacts.length };
				assert.deepEqual(await sdk.rest.post('/v1/chat.react', { messageId: `$enc:${GENERAL}`, emoji: ':tada:' }), { success: true });
				assert.deepEqual(bridge.quickReacts.slice(before.quick), [[GENERAL, '🎉']]);
				assert.equal(bridge.reacts.length, before.reacts, 'no react on any message id: the host picks the target');
				assert.equal(bridge.sent.some((s) => s.text.includes('🎉')), false, 'a quick reaction is never sent as text (Element sends none)');
			} finally {
				bridge.encryption(GENERAL, undefined);
			}
		});

		it('with no ordinary message in the room the quick reaction aimed at the encryption line is the host\'s call (it writes nothing there, as Element): no react, no text, no error', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).splice(0);
			b.encryption(GENERAL, 'enabled');
			const src = new BridgeSource(b);
			assert.equal(src.history(GENERAL).length, 1, 'only the line');
			const sentBefore = b.sent.length;
			assert.deepEqual(await src.react(`$enc:${GENERAL}`, 'tada'), { status: 'done', roomId: GENERAL });
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, []);
			assert.equal(b.sent.length, sentBefore);
		});

		it('the call card is skipped the same way (Element\'s call event is no `m.room.message`)', async () => {
			const b = fixtureBridge();
			const card = { id: '$call', roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: '', ts: Date.now() + 60_000, kind: 'other' as const, call: { callId: '$call', state: 'ongoing' as const, callType: 'video' as const, isDm: false, startedTs: 5000, participants: [], participantCount: 0 } };
			b.timeline(GENERAL).push(card as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.react('$call', 'tada');
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, []);
		});

		// M12 Z4 fix 2 (grok F1): the remap serves only the press `+:name:` can send, the one aimed at the room's NEWEST message
		// (`findLastMessage`). A toolbar or chip click on an older call card / pending-key message keeps its own id (the host then
		// answers `forbidden`, Element's rule: no react control on a call tile), never a write on another message.
		const callCard = (id: string, ts: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: '', ts, kind: 'other' as const, call: { callId: id, state: 'ongoing' as const, callType: 'video' as const, isDm: false, startedTs: 5000, participants: [], participantCount: 0 } });
		const pendingKey = (id: string, ts: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: '', ts, kind: 'text' as const, e2e: { state: 'pending' as const, text: '' } });
		const ordinary = (id: string, ts: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: 'hello', ts, kind: 'text' as const });

		it('a react on a call card that is NOT the newest message keeps its own id: it never lands on the newest message (M1, call card C, M2)', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(callCard('$call', Date.now() + 60_000) as never, ordinary('$m2', Date.now() + 120_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.react('$call', 'tada');
			assert.equal(b.reacts.some((r) => r[1] === '$m2'), false, 'M2 is untouched');
			assert.deepEqual(b.reacts, [[GENERAL, '$call', '🎉']], 'the press goes to the clicked message; the host answers forbidden');
		});

		it('the same for a pending-key message that is not the newest', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(pendingKey('$locked', Date.now() + 60_000) as never, ordinary('$m2', Date.now() + 120_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.react('$locked', 'tada');
			assert.equal(b.reacts.some((r) => r[1] === '$m2'), false, 'M2 is untouched');
			assert.deepEqual(b.reacts, [[GENERAL, '$locked', '🎉']]);
		});

		// M12 Z4 fix 2 (grok F2): Rocket.Chat's optimistic update puts the chip on the pressed message before the POST and never
		// rolls it back; only a stream document replaces the record. A skipped press (remapped or no target) therefore re-emits the
		// skipped message's own kit doc (it has no reactions), so the chip does not stay on a call card or a locked message.
		const changedDocs = (src: InstanceType<typeof BridgeSource>, id: string) => {
			const seen: Record<string, unknown>[] = [];
			src.onChange((c) => c.kind === 'message' && c.op === 'changed' && (c.doc as { _id: string })._id === id && seen.push(c.doc as never));
			return seen;
		};

		it('newest = call card: the skipped card is re-emitted without reactions, the host quick reaction picks the target', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(callCard('$call', Date.now() + 60_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$call');
			await src.react('$call', 'tada');
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, [], 'the kit names no message');
			assert.equal(seen.length, 1, 'one message/changed for the skipped card');
			assert.equal('reactions' in seen[0], false, 'the document carries no reactions, so Rocket.Chat\'s optimistic chip is replaced');
		});

		it('newest = pending-key message: re-emitted the same way', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(pendingKey('$locked', Date.now() + 60_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$locked');
			await src.react('$locked', 'tada');
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, []);
			assert.equal(seen.length, 1);
			assert.equal('reactions' in seen[0], false);
		});

		it('no target (only the encryption line in the room): the host answers `done` (it writes nothing) and the line is re-emitted without reactions', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).splice(0);
			b.encryption(GENERAL, 'enabled');
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, `$enc:${GENERAL}`);
			assert.deepEqual(await src.react(`$enc:${GENERAL}`, 'tada'), { status: 'done', roomId: GENERAL });
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, []);
			assert.equal(seen.length, 1);
			assert.equal('reactions' in seen[0], false);
		});

		// M13 U5 (grok Z4 round-3 F2): "newest" is what Rocket.Chat has been shown, by time (`findLastMessage` keeps the FIRST
		// record of a tie). The press must not reach the host on the skipped id (forbidden toast, chip left on the card).
		it('same-millisecond tie: Rocket.Chat aimed at the call card (first record), the kit stores the ordinary message last: the press is the host quick reaction, no react on the card', async () => {
			const b = fixtureBridge();
			const at = Date.now() + 60_000;
			b.timeline(GENERAL).push(callCard('$call', at) as never, ordinary('$tie', at) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$call');
			await src.react('$call', 'tada');
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']], 'the press goes to the host quick reaction (the host picks the target)');
			assert.deepEqual(b.reacts, [], 'never a react on the call card');
			assert.equal(seen.length, 1, 'the card is re-emitted without the optimistic chip');
			assert.equal('reactions' in seen[0], false);
		});

		it('during loadOlder: a newer row is stored but not shown to Rocket.Chat yet, the press aimed at the call card (its newest) is still the host quick reaction, no react on the card', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(callCard('$call', Date.now() + 60_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$call');
			const load = src.loadOlder(GENERAL);
			b.timeline(GENERAL).push(ordinary('$skew', Date.now() + 120_000) as never);
			b.emit({ kind: 'timeline', roomId: GENERAL });
			await src.react('$call', 'tada');
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']], 'the press is the host quick reaction');
			assert.deepEqual(b.reacts, [], 'not a react on the call card, not on the row held back from Rocket.Chat');
			assert.equal(seen.length, 1);
			assert.equal('reactions' in seen[0], false);
			await load;
		});

		// M13 U6 (Z4 F1): an undecryptable newest message IS an `m.room.message` for Element (js-sdk: `m.bad.encrypted`), so it is the
		// target; Rocket.Chat's `e2e` row has no react control and the call is `chat.react` with an id. The host applies Element's
		// rule (`bridge.quickReact`), the kit names no message.
		const undecryptable = (id: string, ts: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: '', ts, kind: 'text' as const, e2e: { state: 'failed' as const, text: 'Unable to decrypt message' } });

		it('M13 U6: newest = undecryptable (failed) message above a readable one: the host quick reaction is called with the key, no react, the row is re-emitted without the optimistic chip', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(undecryptable('$utd', Date.now() + 60_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$utd');
			assert.deepEqual(await src.react('$utd', ':tada:'), { status: 'done', roomId: GENERAL });
			assert.deepEqual(b.quickReacts, [[GENERAL, '🎉']]);
			assert.deepEqual(b.reacts, [], 'the kit picks no target');
			assert.equal(seen.length, 1);
			assert.equal('reactions' in seen[0], false);
		});

		it('M13 U6: the host refuses the quick reaction (forbidden): a ReactError in Rocket.Chat\'s shape AND the optimistic chip is cleared first (no ghost)', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(undecryptable('$utd', Date.now() + 60_000) as never);
			b.quickReactResult = Object.assign(new Error('not allowed to react here'), { code: 'forbidden' });
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$utd');
			await assert.rejects(src.react('$utd', ':tada:'), (e: any) => e.success === false && e.errorType === 'error-forbidden' && /not allowed/.test(e.error));
			assert.deepEqual(b.reacts, []);
			assert.equal(seen.length, 1, 'the changed document went out before the write, so the refusal leaves no chip');
			assert.equal('reactions' in seen[0], false);
		});

		it('M13 U6: a host without `quickReact` writes nothing (no reaction on a wrong message), the chip is cleared, no error', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(undecryptable('$utd', Date.now() + 60_000) as never);
			(b as { quickReact?: unknown }).quickReact = undefined;
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$utd');
			assert.deepEqual(await src.react('$utd', ':tada:'), { status: 'done' });
			assert.deepEqual(b.reacts, []);
			assert.deepEqual(b.quickReacts, []);
			assert.equal(seen.length, 1);
			assert.equal('reactions' in seen[0], false);
		});

		it('M13 U6: an unknown emoji on the skipped newest row is Rocket.Chat\'s invalid-emoji error, the chip is still cleared and nothing is written', async () => {
			const b = fixtureBridge();
			b.timeline(GENERAL).push(undecryptable('$utd', Date.now() + 60_000) as never);
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const seen = changedDocs(src, '$utd');
			await assert.rejects(src.react('$utd', ':nonesuch:'), (e: any) => e.error === 'Invalid emoji provided.');
			assert.deepEqual(b.quickReacts, []);
			assert.equal(seen.length, 1);
		});

		// M12 Z4 fix 2 item 3 (D38): Element shows no react control on a call tile or a message waiting for its key, so the kit's
		// toolbar wrapper renders none there (a click would be byte-identical to the composer's `+:name:`).
		it('the toolbar wrapper renders no react control for the encryption line, the call card and a pending-key message', () => {
			for (const t of ['room_e2e_enabled', 'videoconf', 'e2e']) assert.equal(isNoMessageEvent({ t } as never), true, t);
			for (const t of [undefined, 'uj', 'message_pinned']) assert.equal(isNoMessageEvent({ t } as never), false, String(t));
			const wrapper = readFileSync(new URL('../src/reaction-message-action.tsx', import.meta.url), 'utf8');
			assert.match(wrapper, /isNoMessageEvent\(props\.message\) \? null : <WithElementPicker/);
		});

		it('rejects an unknown name and an unknown message with Rocket.Chat\'s error shape, pressing nothing', async () => {
			await assert.rejects(sdk.rest.post('/v1/chat.react', { messageId: MID, emoji: ':nonesuch:' }), (e: any) => {
				assert.equal(e.success, false);
				assert.equal(e.error, 'Invalid emoji provided.');
				assert.equal(e.xhr.responseJSON.errorType, 'error-not-allowed');
				return true;
			});
			await assert.rejects(sdk.rest.post('/v1/chat.react', { messageId: '$nope', emoji: ':tada:' }), (e: any) => e.error === 'Message not found');
			assert.deepEqual(bridge.reacts, []);
		});

		it('answers a refused action (forbidden) with the host\'s reason in Rocket.Chat\'s shape', async () => {
			const refusing = fixtureBridge();
			refusing.react = async () => {
				throw Object.assign(new Error('reacting is not allowed on this message'), { code: 'forbidden' });
			};
			const src = new BridgeSource(refusing);
			src.history(GENERAL);
			await assert.rejects(src.react(MID, ':tada:'), (e: any) => e.success === false && e.errorType === 'error-forbidden' && /not allowed/.test(e.error));
		});

		it('E0 R1: the user\'s own sent message (a Rocket.Chat _id) reaches the bridge under its event id, for react and the picker', async () => {
			const b = fixtureBridge();
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.sendText(GENERAL, 'mine', 'rc-own');
			await new Promise((r) => setTimeout(r, 5));
			assert.equal(src.eventIdOf('rc-own'), '$sent1');
			await src.react('rc-own', ':tada:');
			assert.equal(b.reacts.length, 1);
			assert.deepEqual(b.reacts[0].slice(0, 2), [GENERAL, '$sent1']);
			await src.openReactionPicker('rc-own', { x: 1, y: 2, width: 3, height: 4 });
			assert.deepEqual(b.pickers, [[GENERAL, '$sent1']]);
		});

		it('E0 quick reaction: a reaction the user newly has on a message already shown is announced by name, once', () => {
			const b = fixtureBridge();
			const src = new BridgeSource(b);
			src.history(GENERAL);
			const names: string[] = [];
			src.onOwnReaction((n) => names.push(n));
			const list = b.timeline(GENERAL);
			const at = list.findIndex((m) => m.id === MID);
			list[at] = { ...list[at], reactions: [{ key: '\u{1F389}', count: 1, mine: true, senderIds: ['@me:example.org'] }, { key: '\u{1F44D}\uFE0F', count: 1, mine: false, senderIds: ['@bob:example.org'] }] };
			b.emit({ kind: 'timeline', roomId: GENERAL });
			b.emit({ kind: 'timeline', roomId: GENERAL });
			assert.deepEqual(names, ['tada']);
		});

		it('opens the host picker for a loaded message at the clicked control', async () => {
			const out = await getSource().openReactionPicker(MID, { x: 1, y: 2, width: 3, height: 4 });
			assert.equal(out.status, 'done');
			assert.deepEqual(bridge.pickers, [[GENERAL, MID]]);
		});

		it('forwards a loaded message through the host dialog: the Matrix event id, the jump room as the outcome, unsupported as a plain toast', async () => {
			const forwardsBefore = bridge.forwards.length;
			const plain = await getSource().openForward(MID);
			assert.deepEqual(plain, { status: 'done', roomId: GENERAL, eventId: MID });
			bridge.forwardJump = RANDOM;
			try {
				assert.equal((await getSource().openForward(MID)).roomId, RANDOM, 'the dialog\'s room-name jump is the outcome (the button follows it)');
			} finally {
				bridge.forwardJump = undefined;
			}
			assert.deepEqual(bridge.forwards.slice(forwardsBefore), [[GENERAL, MID], [GENERAL, MID]]);
			await assert.rejects(getSource().openForward('$nope'), (e: any) => e.success === false && e.errorType === 'error-message-not-found');
			bridge.forwardResult = Object.assign(new Error('this message cannot be forwarded'), { code: 'unsupported' });
			try {
				await assert.rejects(getSource().openForward(MID), (e: unknown) => {
					assert.equal((e as { errorType: string }).errorType, 'error-unsupported');
					assert.equal(forwardFailure(e), CANNOT_FORWARD, 'a poll gets a plain sentence, never the raw error');
					return true;
				});
			} finally {
				bridge.forwardResult = undefined;
			}
			const other = new Error('boom');
			assert.equal(forwardFailure(other), other, 'any other failure keeps its own message');
			bridge.forwardResult = Object.assign(new Error('another Element dialog action is running'), { code: 'failed' });
			try {
				const busy = await getSource().openForward(MID).catch((e: unknown) => e);
				assert.equal(forwardFailure(busy), busy, 'M11 Y1: a busy host is not "can\'t be forwarded"');
				assert.equal((busy as Error).message, DIALOG_BUSY, 'the forward toast shows the dialog-busy sentence');
			} finally {
				bridge.forwardResult = undefined;
			}
		});

		it('opens View source for a loaded message with its Matrix event id, and answers a refusal in Rocket.Chat\'s shape', async () => {
			const before = bridge.viewSources.length;
			const out = await getSource().openViewSource(MID);
			assert.deepEqual(out, { status: 'done', roomId: GENERAL, eventId: MID });
			assert.deepEqual(bridge.viewSources.slice(before), [[GENERAL, MID]]);
			await assert.rejects(getSource().openViewSource('$nope'), (e: any) => e.success === false && e.errorType === 'error-message-not-found');
			bridge.viewSourceResult = Object.assign(new Error('event not found'), { code: 'unknown_event' });
			try {
				await assert.rejects(getSource().openViewSource(MID), (e: any) => e.success === false && e.errorType === 'error-unknown_event');
			} finally {
				bridge.viewSourceResult = undefined;
			}
		});

		it('copies the Markdown through the host for a loaded message with its Matrix event id, answers a refusal in Rocket.Chat\'s shape and an older host as unsupported (M14 K6)', async () => {
			const before = bridge.copyMarkdowns.length;
			const out = await getSource().copyMarkdown(MID);
			assert.deepEqual(out, { status: 'done', roomId: GENERAL, eventId: MID });
			assert.deepEqual(bridge.copyMarkdowns.slice(before), [[GENERAL, MID]]);
			await assert.rejects(getSource().copyMarkdown('$nope'), (e: any) => e.success === false && e.errorType === 'error-message-not-found');
			bridge.copyMarkdownResult = Object.assign(new Error('the clipboard refused the text'), { code: 'failed' });
			try {
				await assert.rejects(getSource().copyMarkdown(MID), (e: any) => e.success === false && e.errorType === 'error-failed');
			} finally {
				bridge.copyMarkdownResult = undefined;
			}
			const older = (bridge as unknown as { copyMarkdown?: unknown });
			const kept = older.copyMarkdown;
			delete older.copyMarkdown;
			try {
				await assert.rejects(getSource().copyMarkdown(MID), (e: any) => e.success === false && e.errorType === 'error-unsupported');
			} finally {
				older.copyMarkdown = kept;
			}
		});

		it('opens the host thread panel for a loaded message with its Matrix event id, leaves it on a read, and answers a refusal in Rocket.Chat\'s shape (M8 T1)', async () => {
			const before = bridge.threads.length;
			const closes = bridge.threadCloses;
			const out = await getSource().openThread(MID);
			assert.deepEqual(out, { status: 'done', roomId: GENERAL, eventId: MID });
			assert.deepEqual(bridge.threads.slice(before), [[GENERAL, MID]]);
			getSource().markRead(GENERAL);
			getSource().markRead('!other:x');
			assert.equal(bridge.threadCloses, closes, 'marking any room read leaves the panel (F2: Mark as read of another room does not navigate)');
			getSource().closeThread();
			assert.equal(bridge.threadCloses, closes, 'the fixture panel already resolved (closed): closeThread is a no-op');
			await assert.rejects(getSource().openThread('$nope'), (e: any) => e.success === false && e.errorType === 'error-message-not-found');
			bridge.threadResult = Object.assign(new Error('no thread'), { code: 'unsupported' });
			try {
				await assert.rejects(getSource().openThread(MID), (e: any) => e.success === false && e.errorType === 'error-unsupported');
				assert.equal(threadFailure(bridge.threadResult), CANNOT_THREAD);
			} finally {
				bridge.threadResult = undefined;
			}
			getSource().closeThread();
			assert.equal(bridge.threadCloses, closes, 'a refused open leaves no panel to close');
		});

		it('closes the thread panel on a route to another room or a page that is no room, and keeps it for the same room (M8 T1 F1)', async () => {
			const name = getSource().room(GENERAL)?.name;
			// `done` clears the room at once (the fixture resolves), so hold the panel open with a pending host call
			const held = fixtureBridge();
			let release: () => void = () => undefined;
			held.openThread = () => new Promise((res) => { release = () => res({ status: 'done', roomId: GENERAL, eventId: MID }); });
			const src = new BridgeSource(held);
			src.history(GENERAL);
			const pending = src.openThread(MID);
			src.routeChanged({ rid: GENERAL });
			src.routeChanged(name ? { name } : {});
			assert.equal(held.threadCloses, 0, 'the same room (by rid or by name, any tab) keeps the panel');
			src.routeChanged({ rid: '!other:x' });
			assert.equal(held.threadCloses, 1, 'another room closes the panel');
			src.routeChanged({});
			assert.equal(held.threadCloses, 1, 'no panel left: nothing to close');
			release();
			await pending;
			const held2 = fixtureBridge();
			held2.openThread = () => new Promise(() => undefined);
			const src2 = new BridgeSource(held2);
			src2.history(GENERAL);
			void src2.openThread(MID);
			src2.routeChanged({});
			assert.equal(held2.threadCloses, 1, 'a page without a room (Home, directory) closes the panel');
		});

		it('a refused openThread keeps the panel that is open, a resolved one forgets it (M8 T1 F3)', async () => {
			const held = fixtureBridge();
			let calls = 0;
			let release: () => void = () => undefined;
			held.openThread = () => {
				calls += 1;
				if (calls === 2) return Promise.reject(Object.assign(new Error('no thread'), { code: 'unsupported' }));
				return new Promise((res) => { release = () => res({ status: 'done', roomId: GENERAL, eventId: MID }); });
			};
			const src = new BridgeSource(held);
			src.history(GENERAL);
			const first = src.openThread(MID);
			await assert.rejects(src.openThread(MID), (e: any) => e.success === false);
			src.routeChanged({ rid: '!other:x' });
			assert.equal(held.threadCloses, 1, 'the refused open restored the room of the panel that was open');
			release();
			await first;
			src.routeChanged({ rid: '!other:x' });
			assert.equal(held.threadCloses, 1, 'the panel resolved: nothing left to close');
		});

		it('opens Element\'s card panel for a room with the card name, answers a refusal in Rocket.Chat\'s shape and keeps the open panel on a refusal (M9)', async () => {
			const before = bridge.panels.length;
			const out = await getSource().openPanel(GENERAL, 'members');
			assert.deepEqual(out, { status: 'done', roomId: GENERAL });
			assert.deepEqual(bridge.panels.slice(before), [[GENERAL, 'members']]);
			const closes = bridge.panelCloses;
			getSource().closePanel();
			assert.equal(bridge.panelCloses, closes, 'the fixture panel already resolved (closed): closePanel is a no-op');
			bridge.panelResult = Object.assign(new Error('no such card'), { code: 'unsupported' });
			try {
				await assert.rejects(getSource().openPanel(GENERAL, 'search'), (e: any) => e.success === false && e.errorType === 'error-unsupported');
			} finally {
				bridge.panelResult = undefined;
			}
			getSource().closePanel();
			assert.equal(bridge.panelCloses, closes, 'a refused open leaves no panel to close');
		});

		it('opens Element\'s user info of a member with the full Matrix user id in the same panel slot, answers a refusal in Rocket.Chat\'s shape and a host without openUserInfo as unsupported (M14 K4)', async () => {
			const before = bridge.userInfos.length;
			const out = await getSource().openUserInfo(GENERAL, '@bob:example.org');
			assert.deepEqual(out, { status: 'done', roomId: GENERAL });
			assert.deepEqual(bridge.userInfos.slice(before), [[GENERAL, '@bob:example.org']]);
			bridge.userInfoResult = Object.assign(new Error('no member'), { code: 'unsupported' });
			try {
				await assert.rejects(getSource().openUserInfo(GENERAL, '@nobody:example.org'), (e: any) => e.success === false && e.errorType === 'error-unsupported');
			} finally {
				bridge.userInfoResult = undefined;
			}
			const held = fixtureBridge();
			let calls = 0;
			held.openUserInfo = () => {
				calls += 1;
				return new Promise(() => undefined);
			};
			const src = new BridgeSource(held);
			void src.openUserInfo(GENERAL, '@bob:example.org');
			src.routeChanged({ rid: '!other:x' });
			assert.equal(calls, 1);
			assert.equal(held.panelCloses, 1, 'the user info lives in the panel slot: another room closes it');
			const old = fixtureBridge() as any;
			delete old.openUserInfo;
			await assert.rejects(new BridgeSource(old).openUserInfo(GENERAL, '@bob:example.org'), (e: any) => e.success === false && e.errorType === 'error-unsupported');
		});

		it('closes the card panel on a route to another room or a page that is no room, keeps it for the same room, and a refusal keeps the open one (M9)', async () => {
			const name = getSource().room(GENERAL)?.name;
			const held = fixtureBridge();
			let calls = 0;
			let release: () => void = () => undefined;
			held.openPanel = () => {
				calls += 1;
				if (calls === 2) return Promise.reject(Object.assign(new Error('no card'), { code: 'unsupported' }));
				return new Promise((res) => { release = () => res({ status: 'done', roomId: GENERAL }); });
			};
			const src = new BridgeSource(held);
			const first = src.openPanel(GENERAL, 'info');
			await assert.rejects(src.openPanel(GENERAL, 'pinned'), (e: any) => e.success === false);
			src.routeChanged({ rid: GENERAL });
			src.routeChanged(name ? { name } : {});
			assert.equal(held.panelCloses, 0, 'the same room (by rid or by name, any tab) keeps the panel');
			src.routeChanged({ rid: '!other:x' });
			assert.equal(held.panelCloses, 1, 'another room closes the panel');
			src.routeChanged({});
			assert.equal(held.panelCloses, 1, 'no panel left: nothing to close');
			release();
			await first;
			const held2 = fixtureBridge();
			held2.openPanel = () => new Promise(() => undefined);
			const src2 = new BridgeSource(held2);
			void src2.openPanel(GENERAL, 'files');
			src2.routeChanged({});
			assert.equal(held2.panelCloses, 1, 'a page without a room (Home, directory) closes the panel');
		});

		it('hands a host jump to the kit with Rocket.Chat\'s _id for the event (F1) and passes a room open through; a v2 host has neither (M9)', () => {
			const held = fixtureBridge();
			const src = new BridgeSource(held);
			(src as any).adopt(GENERAL, '$ev1', 'rc-id-1');
			const jumps: { roomId: string; id: string }[] = [];
			const rooms: { roomId: string; id?: string }[] = [];
			const offJ = src.onJump((j) => jumps.push(j));
			const offR = src.onRoomOpen((j) => rooms.push(j));
			held.emitJump({ roomId: GENERAL, eventId: '$ev1' });
			held.emitJump({ roomId: GENERAL, eventId: '$ev-unsent-here' });
			held.emitRoomOpen({ roomId: '!bob:example.org' });
			held.emitRoomOpen({ roomId: GENERAL, eventId: '$ev1' });
			held.emitRoomOpen({ roomId: GENERAL, eventId: '$ev-unknown' });
			assert.deepEqual(jumps, [{ roomId: GENERAL, id: 'rc-id-1' }, { roomId: GENERAL, id: '$ev-unsent-here' }]);
			assert.deepEqual(rooms, [
				{ roomId: '!bob:example.org' },
				{ roomId: GENERAL, id: 'rc-id-1' },
				{ roomId: GENERAL, id: '$ev-unknown' },
			]);
			offJ();
			offR();
			held.emitJump({ roomId: GENERAL, eventId: '$ev1' });
			assert.equal(jumps.length, 2, 'unsubscribed');
			const v2 = fixtureBridge() as any;
			delete v2.onJump;
			delete v2.onRoomOpen;
			delete v2.openPanel;
			const old = new BridgeSource(v2);
			assert.doesNotThrow(() => old.onJump(() => undefined)());
			assert.doesNotThrow(() => old.onRoomOpen(() => undefined)());
		});

		it('opens the host report dialog for a loaded message and carries a refusal or an unknown message as an error (M7 E4)', async () => {
			const out = await getSource().openReport(MID);
			assert.equal(out.status, 'done');
			assert.deepEqual(bridge.reports, [[GENERAL, MID]]);
			await assert.rejects(getSource().openReport('$nope'), (e: any) => e.error === 'Message not found');
			const refusing = fixtureBridge();
			refusing.openReport = async () => {
				throw Object.assign(new Error('an own message is not reported'), { code: 'forbidden' });
			};
			const src = new BridgeSource(refusing);
			src.history(GENERAL);
			await assert.rejects(src.openReport(MID), (e: any) => e.success === false && e.errorType === 'error-forbidden');
			assert.equal(refusing.reports.length, 0);
		});
	});

	it('rejects AND records everything unmapped, never a fake success', async () => {
		await assert.rejects(sdk.rest.get('/v1/rooms.info', { roomId: GENERAL }), /N\/A: rest.get \/v1\/rooms.info/);
		await assert.rejects(sdk.rest.post('/v1/chat.starMessage', {}), /N\/A/);
		await assert.rejects(sdk.call('createDirectMessage', 'bob'), /N\/A: call createDirectMessage/);
		assert.throws(() => sdk.rest.upload('/v1/rooms.media'), /N\/A/);
		assert.deepEqual(
			stubLog.map((s) => `${s.kind} ${s.name}`),
			['rest.get /v1/rooms.info', 'rest.post /v1/chat.starMessage', 'call createDirectMessage', 'rest.upload /v1/rooms.media'],
		);
		// In the browser globalThis is the window: this is window.__clientViewStubLog.
		assert.equal((globalThis as unknown as { __clientViewStubLog: unknown[] }).__clientViewStubLog, stubLog);
	});

	it('streams deliver bridge changes on Rocket.Chat stream keys', () => {
		const got: unknown[][] = [];
		const h = sdk.stream('notify-user', [`${getSource().me._id}/subscriptions-changed`], (...a: unknown[]) => got.push(a));
		bridge.rooms().find((r) => r.id === GENERAL)!.unreadCount = 3;
		bridge.emit({ kind: 'rooms' });
		h.stop();
		assert.equal(got[0]?.[0], 'changed');
		assert.equal((got[0]?.[1] as { unread: number }).unread, 3);
	});

	it('the connection state is the bridge state', () => {
		bridge.conn = 'offline';
		bridge.emit({ kind: 'connection' });
		assert.equal(sdk.connection.status, 'connecting');
		assert.deepEqual(Meteor.status(), { connected: false, status: 'waiting', retryCount: 0 });
		bridge.conn = 'online';
		assert.equal(Meteor.status().connected, true);
	});

	it('Meteor calls throw N/A and are recorded', () => {
		assert.throws(() => Meteor.call('sendMessage'), /N\/A: meteor.call sendMessage/);
		assert.equal(stubLog.at(-1)?.name, 'sendMessage');
	});
});

describe('send (A1, interim)', () => {
	const post = (rid: string, msg: string, _id = 'rc-1') => sdk.rest.post('/v1/chat.sendMessage', { message: { _id, rid, msg } });
	const collect = (src: InstanceType<typeof BridgeSource>) => {
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'message' && seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		return seen;
	};
	const tick = () => new Promise((r) => setTimeout(r, 5));

	it('POST chat.sendMessage maps Rocket.Chat markup to CommonMark and sends markdown: true (E1)', async () => {
		await post(GENERAL, 'a *bold* and ~strike~ and <https://example.org|link> and `*code*`');
		assert.deepEqual(bridge.sent.at(-1), { roomId: GENERAL, text: 'a **bold** and <del>strike</del> and [link](https://example.org) and `*code*`', txnId: 'rc-' + (bridge.sent.length), markdown: true });
	});

	it('POST chat.sendMessage sends the text through the bridge with the Rocket.Chat _id as transaction id', async () => {
		const answer = (await post(GENERAL, 'hello there')) as { success: boolean; message: { _id: string } };
		assert.equal(answer.success, true);
		assert.equal(answer.message._id, 'rc-1');
		assert.deepEqual(bridge.sent.at(-1), { roomId: GENERAL, text: 'hello there', txnId: 'rc-1', markdown: true });
		assert.ok(answeredLog.includes('POST /v1/chat.sendMessage'));
	});

	it('the confirming row keeps the Rocket.Chat _id when the promise resolves first: one row, no second _id', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const seen = collect(src);
		await src.sendText(GENERAL, 'one row', 'rc-a');
		await tick();
		assert.deepEqual(seen, ['changed:rc-a']);
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'one row').map((m) => m._id), ['rc-a']);
		assert.equal(src.eventIdOf('rc-a'), '$sent1');
		assert.equal(src.message('rc-a')?.msg, 'one row');
	});

	it('the confirming row keeps the Rocket.Chat _id when the row arrives first', async () => {
		const b = fixtureBridge();
		b.sendMode = 'echo-first';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const seen = collect(src);
		await src.sendText(GENERAL, 'echo first', 'rc-b');
		await tick();
		assert.deepEqual(seen, ['changed:rc-b']);
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'echo first').map((m) => m._id), ['rc-b']);
	});

	it('T1: a row that arrives without the transaction id before the promise resolves is never shown under the event id', async () => {
		const b = fixtureBridge();
		b.sendMode = 'echo-first';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const send = b.sendText;
		b.sendText = async (roomId, text) => send(roomId, text, {}); // the txnId is lost on the way
		const seen = collect(src);
		await src.sendText(GENERAL, 'lost txn', 'rc-c');
		await tick();
		assert.deepEqual(seen, ['changed:rc-c']);
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'lost txn').map((m) => m._id), ['rc-c']);
	});

	it('T1: a row that arrives without the transaction id after the promise resolves is shown under the Rocket.Chat _id', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const send = b.sendText;
		b.sendText = async (roomId, text) => send(roomId, text, {});
		const seen = collect(src);
		await src.sendText(GENERAL, 'late echo', 'rc-l');
		await tick();
		assert.deepEqual(seen, ['changed:rc-l']);
	});

	it('T1: an own row nobody adopted (sent from another device) is held while a send is in flight and shown when it ends', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const seen = collect(src);
		let release: () => void = () => {};
		b.sendText = async (roomId) => {
			const tl = b.timeline(roomId) as { id: string; roomId: string; senderId: string; senderName: string; body: string; ts: number; kind: 'text' }[];
			tl.push({ id: '$other', roomId, senderId: '@alice:example.org', senderName: 'Alice', body: 'from the phone', ts: Date.now(), kind: 'text' });
			b.emit({ kind: 'timeline', roomId });
			await new Promise<void>((r) => (release = r));
			return { status: 'done' as const, roomId, eventId: '$mine' };
		};
		const pending = src.sendText(GENERAL, 'mine', 'rc-p');
		await tick();
		assert.deepEqual(seen, [], 'held while the send is in flight');
		release();
		await pending;
		assert.deepEqual(seen, ['changed:$other']);
		// someone else's row is never held
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'from the phone').map((m) => m._id), ['$other']);
	});

	it('T2: a row shown under its event id is withdrawn before it reappears under the _id when its transaction id arrives later', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const tl = b.timeline(GENERAL) as { id: string; roomId: string; senderId: string; senderName: string; body: string; ts: number; kind: 'text'; txnId?: string }[];
		const row = { id: '$early', roomId: GENERAL, senderId: '@alice:example.org', senderName: 'Alice', body: 'early', ts: Date.now(), kind: 'text' as const };
		tl.push(row);
		b.emit({ kind: 'timeline', roomId: GENERAL }); // no send in flight: shown under the event id
		const seen = collect(src);
		b.sendText = async (roomId) => {
			Object.assign(row, { txnId: 'rc-t' }); // the same event now carries its transaction id
			b.emit({ kind: 'timeline', roomId });
			return { status: 'done' as const, roomId, eventId: '$early' };
		};
		await src.sendText(GENERAL, 'early', 'rc-t');
		await tick();
		assert.deepEqual(seen, ['removed:$early', 'changed:rc-t']);
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'early').map((m) => m._id), ['rc-t']);
	});

	it('no delete notification is sent for a send that was never shown under the event id', async () => {
		const got: unknown[] = [];
		const h = sdk.stream('notify-room', [`${GENERAL}/deleteMessage`], (m) => got.push(m));
		const src = getSource();
		src.history(GENERAL);
		const send = bridge.sendText;
		bridge.sendMode = 'echo-first';
		bridge.sendText = async (roomId, text) => send(roomId, text, {});
		await post(GENERAL, 'delete me', 'rc-d');
		await tick();
		bridge.sendText = send;
		bridge.sendMode = 'resolve-first';
		h.stop();
		assert.deepEqual(got, []);
	});

	it('a rejection is Rocket.Chat\'s error shape and leaves no row', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject';
		const src = new BridgeSource(b);
		const seen = collect(src);
		await assert.rejects(src.sendText(GENERAL, 'no', 'rc-e'), /not allowed/);
		assert.deepEqual(seen, ['removed:rc-e'], "the optimistic row Rocket.Chat keeps after a failed send is withdrawn (D21)");
		bridge.sendMode = 'reject';
		await assert.rejects(post(GENERAL, 'no', 'rc-f'), (e: Error & { success: boolean; error: string; errorType: string }) =>
			e.success === false && e.error === 'not allowed' && e.errorType === 'error-forbidden');
		bridge.sendMode = 'resolve-first';
		await tick();
		assert.ok(!bridge.timeline(GENERAL).some((m) => m.body === 'no'));
	});

	it('M11 Y1: a send refused by the host as a plain object (another realm, not an Error: the kit runs in an iframe) toasts its message, not `ClientViewActionError: ...`', async () => {
		const crossRealm = { name: 'ClientViewActionError', message: 'x', code: 'failed' };
		assert.equal(crossRealm instanceof Error, false, 'the fixture is not an Error of this realm');
		const sendText = bridge.sendText;
		bridge.sendText = async () => { throw crossRealm; };
		try {
			await assert.rejects(post(GENERAL, 'no', 'rc-xr'), (e: Error & { success: boolean; error: string; errorType: string }) =>
				e.success === false && e.error === 'x' && e.message === 'x' && e.errorType === 'error-failed');
		} finally {
			bridge.sendText = sendText;
		}
	});

	it('a bridge without actions (version 1) rejects the send as unsupported', async () => {
		const b = fixtureBridge();
		delete (b as { sendText?: unknown }).sendText;
		await assert.rejects(new BridgeSource(b).sendText(GENERAL, 'x', 'rc-g'), /bridge version 2/);
	});
});

describe('emoji in the composer (M6 B3)', () => {
	const names: Record<string, string> = { ':smile:': '\u{1F604}', ':tada:': '\u{1F389}', ':100:': '\u{1F4AF}' };
	beforeEach(() => setReactionUnicode((name) => names[name]));
	afterEach(() => setReactionUnicode(() => undefined));

	it('a known shortcode becomes the Unicode emoji, an unknown one stays text', () => {
		assert.equal(shortcodesToUnicode('hi :smile: and :tada:!'), 'hi \u{1F604} and \u{1F389}!');
		assert.equal(shortcodesToUnicode(':nonesuch: :smile:'), ':nonesuch: \u{1F604}');
		assert.equal(shortcodesToUnicode(':SMILE:'), '\u{1F604}');
	});

	it('times, code spans and fences are left alone', () => {
		assert.equal(shortcodesToUnicode('at 10:100:5 and a:smile:b'), 'at 10:100:5 and a:smile:b');
		assert.equal(shortcodesToUnicode('`:smile:` :smile:'), '`:smile:` \u{1F604}');
		assert.equal(shortcodesToUnicode('```\n:smile:\n```\n:smile:'), '```\n:smile:\n```\n\u{1F604}');
	});

	it('F1: adjacent shortcodes in a run all convert', () => {
		assert.equal(shortcodesToUnicode(':smile::tada:'), '\u{1F604}\u{1F389}');
		assert.equal(shortcodesToUnicode('x :smile::nonesuch::tada::100: y'), 'x \u{1F604}:nonesuch:\u{1F389}\u{1F4AF} y');
		assert.equal(shortcodesToUnicode('a:smile::tada:'), 'a:smile::tada:');
	});

	it('F2: a shortcode inside a URL stays', () => {
		assert.equal(shortcodesToUnicode('see https://host/path/:smile:/x :smile:'), 'see https://host/path/:smile:/x \u{1F604}');
		assert.equal(shortcodesToUnicode('git+ssh://h/:tada:'), 'git+ssh://h/:tada:');
	});

	it('F3: chat.update sends the Unicode emoji too', async () => {
		const edits: unknown[] = [];
		const src = getSource() as unknown as { editText: (id: string, text: string) => Promise<unknown> };
		const original = src.editText;
		src.editText = async (id, text) => (edits.push([id, text]), undefined);
		try {
			await sdk.rest.post('/v1/chat.update', { roomId: GENERAL, msgId: '$m1', text: 'fixed :tada::smile: https://h/:tada:' });
		} finally {
			src.editText = original;
		}
		assert.deepEqual(edits, [['$m1', 'fixed \u{1F389}\u{1F604} https://h/:tada:']]);
	});

	it('POST chat.sendMessage sends the Unicode emoji', async () => {
		await sdk.rest.post('/v1/chat.sendMessage', { message: { _id: 'rc-e1', rid: GENERAL, msg: 'party :tada:' } });
		assert.deepEqual(bridge.sent.at(-1), { roomId: GENERAL, text: 'party \u{1F389}', txnId: 'rc-e1', markdown: true });
	});

	it('/v1/emoji-custom.list answers an empty custom emoji list', async () => {
		assert.deepEqual(await sdk.rest.get('/v1/emoji-custom.list'), { emojis: { update: [], remove: [] }, success: true });
		assert.ok(answeredLog.includes('GET /v1/emoji-custom.list'));
	});
});

describe('send failure (A1 follow-up, D21)', () => {
	const collect = (src: InstanceType<typeof BridgeSource>) => {
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'message' && seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		return seen;
	};

	it('track F1: a rejection keeps the row when the homeserver already holds the message (its echo carries the txnId)', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-after-echo';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const seen = collect(src);
		const outcome = await src.sendText(GENERAL, 'it arrived', 'rc-h');
		assert.deepEqual(outcome, { status: 'done', roomId: GENERAL, eventId: '$sent1' });
		assert.ok(!seen.some((s) => s.startsWith('removed:')), `no row withdrawn: ${seen.join(',')}`);
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'it arrived').map((m) => m._id), ['rc-h']);
		assert.equal(src.eventIdOf('rc-h'), '$sent1');
	});

	it('track F1: a rejection with no echo withdraws the optimistic row, and the error reaches Rocket.Chat', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject';
		const src = new BridgeSource(b);
		const seen = collect(src);
		await assert.rejects(src.sendText(GENERAL, 'refused', 'rc-i'), /not allowed/);
		assert.deepEqual(seen, ['removed:rc-i']);
	});

	it('track F1 (round 2): a send whose answer was lost and is sent again posts one message: the resend reuses the transaction id', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-lost';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		await assert.rejects(src.sendText(GENERAL, 'once only', 'rc-lost-1'), /connection lost/);
		// the user presses Enter again (the text came back into the composer): a new Rocket.Chat _id, the same text
		await src.sendText(GENERAL, 'once only', 'rc-lost-2');
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(b.sent[0].txnId, 'rc-lost-1');
		assert.equal(b.sent[1].txnId, 'rc-lost-1', 'the resend reuses the failed send\'s transaction id');
		assert.equal(b.timeline(GENERAL).filter((m) => m.body === 'once only').length, 1, 'the homeserver holds one message');
		assert.deepEqual(src.history(GENERAL).filter((m) => m.msg === 'once only').map((m) => m._id), ['rc-lost-2'], 'and one row is shown, under the new _id');
		// a different text is a new message with its own transaction id
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'other text', 'rc-lost-3');
		assert.equal(b.sent[2].txnId, 'rc-lost-3');
	});

	it('track F1 (round 2): a late echo of the failed send shows once, and a later identical send is a new message', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-lost';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		await assert.rejects(src.sendText(GENERAL, 'late one', 'rc-late-1'), /connection lost/);
		b.lost!.deliver();
		assert.equal(src.history(GENERAL).filter((m) => m.msg === 'late one').length, 1, 'the late echo is one row');
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'late one', 'rc-late-2');
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(b.sent.at(-1)!.txnId, 'rc-late-2', 'the echo arrived: nothing to deduplicate, a fresh transaction id');
		assert.equal(b.timeline(GENERAL).filter((m) => m.body === 'late one').length, 2);
	});

	it('track F1 (round 3): a resend with another quote (or none) is a different message: a fresh transaction id', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-lost';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		await assert.rejects(src.sendText(GENERAL, 'yes', 'rc-y1'), /connection lost/);
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'yes', 'rc-y2', '$m1');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-y2', 'the text matches but the reply is new');
		assert.equal(b.sent.at(-1)!.replyTo, '$m1');
		b.sendMode = 'reject-lost';
		await assert.rejects(src.sendText(GENERAL, 'quoted', 'rc-q1', '$m1'), /connection lost/);
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'quoted', 'rc-q2', '$m2');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-q2', 'another quoted message');
		b.sendMode = 'reject-lost';
		await assert.rejects(src.sendText(GENERAL, 'same', 'rc-s1', '$m1'), /connection lost/);
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'same', 'rc-s2', '$m1');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-s1', 'same text and same quote: the retry');
	});

	it('track F2 (round 3): a later successful send of other text keeps the unacknowledged transaction id for the retry', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-lost';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		await assert.rejects(src.sendText(GENERAL, 'hello', 'rc-h1'), /connection lost/);
		b.sendMode = 'resolve-first';
		await src.sendText(GENERAL, 'bye', 'rc-b1');
		await src.sendText(GENERAL, 'hello', 'rc-h2');
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(b.sent.at(-1)!.txnId, 'rc-h1');
		assert.equal(b.timeline(GENERAL).filter((m) => m.body === 'hello').length, 1);
	});

	it('track F3 (round 3): a late echo held back by another send in flight does not clear the id: the retry still deduplicates', async () => {
		const b = fixtureBridge();
		b.sendMode = 'reject-lost';
		const src = new BridgeSource(b);
		src.history(GENERAL);
		await assert.rejects(src.sendText(GENERAL, 'hello', 'rc-h1'), /connection lost/);
		const send = b.sendText;
		let release: () => void = () => undefined;
		b.sendText = (roomId, text, opts) => (text === 'bye' ? new Promise((res) => { release = () => res(send(roomId, text, opts)); }) : send(roomId, text, opts));
		b.sendMode = 'resolve-first';
		const bye = src.sendText(GENERAL, 'bye', 'rc-b1');
		b.lost!.deliver();
		assert.equal(src.history(GENERAL).filter((m) => m.msg === 'hello').length, 0, 'the echo is held back while bye is in flight');
		await src.sendText(GENERAL, 'hello', 'rc-h2');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-h1', 'the retry reuses the id');
		release();
		await bye;
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(b.timeline(GENERAL).filter((m) => m.body === 'hello').length, 1);
	});

	it('track F2: the text of a rejected composer send goes back into the composer (quotes stripped), not for an accepted one', async () => {
		const restored: string[][] = [];
		setRestoreComposer((rid, text) => void restored.push([rid, text]));
		const post = (msg: string, _id: string) => sdk.rest.post('/v1/chat.sendMessage', { message: { _id, rid: GENERAL, msg } });
		bridge.sendMode = 'reject';
		await assert.rejects(post('keep this text', 'rc-j'), /not allowed/);
		await assert.rejects(post(`[ ](http://x/channel/general?msg=%24m1)\nquoted but refused`, 'rc-k'), /not allowed/);
		bridge.sendMode = 'resolve-first';
		await post('goes through', 'rc-l');
		assert.deepEqual(restored, [[GENERAL, 'keep this text'], [GENERAL, 'quoted but refused']]);
		setRestoreComposer(() => undefined);
	});
});

describe('composer restore (track F2)', () => {
	it('puts the lost text before whatever was typed meanwhile', () => {
		assert.equal(restoredText('', 'lost'), 'lost');
		assert.equal(restoredText('  \n', 'lost'), 'lost');
		assert.equal(restoredText('new draft', 'lost'), 'lost\nnew draft');
	});

	it('does nothing for a blank text or when the composer on screen is another room\'s (the route says which)', () => {
		const doc = { querySelector: () => { throw new Error('must not look for a composer'); } } as unknown as Document;
		assert.equal(restoreComposerText(GENERAL, '   ', doc), false);
		assert.equal(restoreComposerText(GENERAL, 'lost', doc), false, 'the kit is on /home, not on the room');
		assert.equal(restoreComposerText('!nobody:x', 'lost', doc), false);
	});

	it('grok track F1: composerHolds is true only for the connected textarea of the room at the route that holds the text', () => {
		const win2 = (globalThis as { window: { location: { hash: string } } }).window;
		const textarea = (value: string, isConnected = true) => ({ querySelector: () => ({ value, isConnected }) }) as unknown as Document;
		const previous = win2.location.hash;
		try {
			win2.location.hash = '#/direct/!bob%253Aexample.org';
			assert.equal(composerHolds('!bob:example.org', 'lost', textarea('lost\nnew')), true);
			assert.equal(composerHolds('!bob:example.org', 'lost', textarea('something else')), false, 'the new textarea is empty or another one');
			assert.equal(composerHolds('!bob:example.org', 'lost', textarea('lost', false)), false, 'the textarea was unmounted');
			assert.equal(composerHolds('!bob:example.org', 'lost', { querySelector: () => null } as unknown as Document), false);
			const away = { querySelector: () => { throw new Error('must not look for a composer'); } } as unknown as Document;
			assert.equal(composerHolds('!nobody:x', 'lost', away), false, 'a room that left the list');
			win2.location.hash = '#/home';
			assert.equal(composerHolds('!bob:example.org', 'lost', away), false, 'the route is not that room');
			win2.location.hash = '#/direct/!bob%253Aexample.org';
			assert.equal(restoreComposerText('!bob:example.org', 'lost', textarea('', false)), false, 'no write into an unmounted textarea');
		} finally {
			win2.location.hash = previous;
		}
	});

	it('grok track F1: saveRoomDraft writes Rocket.Chat\'s own draft key, keeps what is there, and never doubles the text', () => {
		const store = new Map<string, string>();
		const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
		saveRoomDraft('!r:x', 'lost', storage);
		assert.deepEqual([...store], [['messagebox_!r:x', 'lost']]);
		saveRoomDraft('!r:x', 'lost', storage);
		assert.equal(store.get('messagebox_!r:x'), 'lost', 'already there: unchanged');
		store.set('messagebox_!r:y', 'typed since');
		saveRoomDraft('!r:y', 'lost', storage);
		assert.equal(store.get('messagebox_!r:y'), 'lost\ntyped since');
		saveRoomDraft('!r:z', '  ', storage);
		assert.equal(store.has('messagebox_!r:z'), false);
	});

	it('track F3 (round 2): the route compares by room, whatever the encoding (Rocket.Chat encodes + % / twice)', () => {
		assert.equal(settledPath('/direct/local%252B1'), '/direct/local+1');
		assert.equal(settledPath(roomPath({ _id: 'local+1', t: 'd', name: 'x' })), '/direct/local+1');
		assert.equal(settledPath('/direct/a%252Fb%2525c'), settledPath(roomPath({ _id: 'a/b%c', t: 'd', name: 'x' })));
		assert.equal(settledPath('/direct/100%'), '/direct/100%', 'a path that does not decode is left as it is');
		// the room at the route reaches the composer (the doc throws when asked for it): a false restore is loud here
		const win2 = (globalThis as { window: { location: { hash: string } } }).window;
		const doc = { querySelector: () => { throw new Error('reached the composer'); } } as unknown as Document;
		const previous = win2.location.hash;
		try {
			win2.location.hash = '#/direct/!bob%253Aexample.org';
			assert.throws(() => restoreComposerText('!bob:example.org', 'lost', doc), /reached the composer/);
		} finally {
			win2.location.hash = previous;
		}
	});
});

describe('reply (A3)', () => {
	it('parseQuotes reads the Quote action\'s permalink prefixes (one per line) and leaves other links in the text', () => {
		assert.deepEqual(parseQuotes('plain'), { text: 'plain', quoted: [] });
		assert.deepEqual(parseQuotes('[ ](http://h/channel/general-1?msg=%24abc)\nanswer'), { text: 'answer', quoted: ['$abc'] });
		assert.deepEqual(parseQuotes('[ ](http://h/direct/!r:x?msg=$one)\n[ ](http://h/direct/!r:x?msg=$two)\ntwo quotes'), { text: 'two quotes', quoted: ['$one', '$two'] });
		assert.deepEqual(parseQuotes('[ ](http://h/channel/g?msg=$q)'), { text: '', quoted: ['$q'] });
		assert.deepEqual(parseQuotes('see [ ](http://h/channel/g?msg=$q) inline'), { text: 'see [ ](http://h/channel/g?msg=$q) inline', quoted: [] });
		assert.deepEqual(parseQuotes('[docs](http://h/channel/g?msg=$q) is a link'), { text: '[docs](http://h/channel/g?msg=$q) is a link', quoted: [] });
		assert.equal(roomPath({ _id: '!r:x', t: 'd', name: 'x' }), '/direct/!r%3Ax');
		assert.equal(messageLink({ _id: '!r:x', t: 'c', name: 'room-1' }, '$e'), '/channel/room-1?msg=%2524e');
	});

	it('POST chat.sendMessage with a quote sends the text without the permalink and the quoted id as replyTo', async () => {
		const answer = (await sdk.rest.post('/v1/chat.sendMessage', {
			message: { _id: 'rc-r1', rid: GENERAL, msg: '[ ](http://localhost/channel/general-chat?msg=$m1)\nyes please' },
		})) as { success: boolean };
		assert.equal(answer.success, true);
		assert.deepEqual(bridge.sent.at(-1), { roomId: GENERAL, text: 'yes please', txnId: 'rc-r1', replyTo: '$m1', markdown: true });
	});

	it('an RC _id the kit minted is mapped to its Matrix event id; the reply row carries the quote attachment', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const settle = () => new Promise((r) => setTimeout(r, 5));
		await src.sendText(GENERAL, 'mine', 'rc-own');
		await settle();
		await src.sendText(GENERAL, 'reply to mine', 'rc-reply', 'rc-own');
		await settle();
		assert.equal(b.sent.at(-1)?.replyTo, '$sent1', 'the event id, not the RC _id');
		const row = src.history(GENERAL).find((m) => m._id === 'rc-reply') as unknown as { attachments: { text: string; author_name: string }[] };
		assert.equal(row.attachments[0].text, 'mine');
		assert.equal(row.attachments[0].author_name, 'Alice');
	});
});

describe('copy markdown (M14 K6)', () => {
	const MID = '$m1';

	it('the document carries Element\'s Copy Markdown rule as kitCanCopyMarkdown (M14 K6)', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		Object.assign(b.timeline(GENERAL).find((m) => m.id === MID)!, { canCopyMarkdown: true });
		const d = (id: string) => src.history(GENERAL).find((m) => m._id === id) as unknown as { kitCanCopyMarkdown: boolean };
		assert.deepEqual([d(MID).kitCanCopyMarkdown, d('$m2').kitCanCopyMarkdown], [true, false], 'a message the host does not offer to copy gets none');
	});
});

describe('pin and unpin (M6 B2)', () => {
	const MID = '$m1';
	const doc = (src: BridgeSource, id: string) => src.history(GENERAL).find((m) => m._id === id) as unknown as { pinned: boolean; kitCanPin: boolean };

	it('the document carries the pinned mark and Element\'s pin rule as kitCanPin', () => {
		const b = fixtureBridge();
		Object.assign(b.timeline(GENERAL).find((m) => m.id === MID)!, { canPin: true, pinned: true });
		const src = new BridgeSource(b);
		assert.deepEqual([doc(src, MID).pinned, doc(src, MID).kitCanPin], [true, true]);
		assert.deepEqual([doc(src, '$m2').pinned, doc(src, '$m2').kitCanPin], [false, false], 'a message the host does not offer to pin gets none');
	});

	it('POST chat.pinMessage and chat.unPinMessage call setPinned with the Matrix event id; the mark follows the host', async () => {
		getSource().history(GENERAL);
		const pinned = (await sdk.rest.post('/v1/chat.pinMessage', { messageId: MID })) as { success: boolean };
		assert.equal(pinned.success, true);
		assert.deepEqual(bridge.pins.at(-1), [GENERAL, MID, true]);
		assert.equal(doc(getSource(), MID).pinned, true);
		await sdk.rest.post('/v1/chat.unPinMessage', { messageId: MID });
		assert.deepEqual(bridge.pins.at(-1), [GENERAL, MID, false]);
		assert.equal(doc(getSource(), MID).pinned, false);
		assert.ok(answeredLog.includes('POST /v1/chat.pinMessage') && answeredLog.includes('POST /v1/chat.unPinMessage'));
	});

	it('a refusal is Rocket.Chat\'s error and the message stays unpinned; an unknown message and a missing id are errors', async () => {
		getSource().history(GENERAL);
		bridge.actionMode = 'reject';
		await assert.rejects(sdk.rest.post('/v1/chat.pinMessage', { messageId: '$m2' }), (e: Error & { success: boolean; errorType: string }) => e.success === false && e.errorType === 'error-forbidden');
		bridge.actionMode = 'ok';
		assert.equal(doc(getSource(), '$m2').pinned, false, 'the refused pin left no mark');
		await assert.rejects(sdk.rest.post('/v1/chat.pinMessage', { messageId: '$nope' }), /Message not found/);
		await assert.rejects(sdk.rest.post('/v1/chat.pinMessage', {}), /error-invalid-params/);
	});

	it('grants the setting and the permission Rocket.Chat\'s own Pin and Unpin items read', async () => {
		const settings = (await sdk.call('public-settings/get')) as Array<{ _id: string; value: unknown }>;
		assert.equal(settings.find((s) => s._id === 'Message_AllowPinning')?.value, true);
		const perms = ((await sdk.call('permissions/get')) as Array<{ _id: string }>).map((p) => p._id);
		assert.ok(perms.includes('pin-message'));
	});
});

describe('edit (A11) and delete (A12)', () => {
	const MID = '$m1';
	const mine = (b: ReturnType<typeof fixtureBridge>) => {
		// Alice's own message in the fixture room.
		const tl = b.timeline(GENERAL) as { id: string; senderId: string; canEdit?: boolean }[];
		Object.assign(tl.find((m) => m.id === MID)!, { canEdit: true });
	};

	it('the document carries Element\'s permalink as kitPermalink; a message without one has none (no Copy link)', () => {
		const b = fixtureBridge();
		const tl = b.timeline(GENERAL) as { id: string; permalink?: string }[];
		Object.assign(tl.find((m) => m.id === MID)!, { permalink: `https://matrix.to/#/${GENERAL}/${MID}?via=example.org` });
		const src = new BridgeSource(b);
		const doc = (id: string) => src.history(GENERAL).find((m) => m._id === id) as unknown as { kitPermalink?: string };
		assert.equal(doc(MID).kitPermalink, `https://matrix.to/#/${GENERAL}/${MID}?via=example.org`);
		assert.equal('kitPermalink' in doc('$m2'), false);
	});

	it('the document carries Element\'s edit rule as kitCanEdit, and the edited mark', async () => {
		const b = fixtureBridge();
		mine(b);
		const src = new BridgeSource(b);
		assert.equal((src.history(GENERAL).find((m) => m._id === MID) as unknown as { kitCanEdit: boolean }).kitCanEdit, true);
		assert.equal((src.history(GENERAL).find((m) => m._id === '$m2') as unknown as { kitCanEdit: boolean }).kitCanEdit, false);
		assert.equal('editedAt' in src.history(GENERAL)[0], false);
		await src.editText(MID, 'changed');
		const edited = src.history(GENERAL).find((m) => m._id === MID) as unknown as { msg: string; editedAt: Date; editedBy: { _id: string } };
		assert.equal(edited.msg, 'changed');
		assert.ok(edited.editedAt instanceof Date);
		const original = b.timeline(GENERAL).find((m) => m.id === MID)!;
		assert.equal(edited.editedAt.getTime(), original.editedTs, 'timed by the replacement the host names, not the original');
		assert.ok(original.editedTs! > original.ts);
		assert.equal(edited.editedBy._id, '@alice:example.org');
	});

	it('POST chat.update drops the Quote chip\'s permalink: an edit cannot change the reply relation, the body is the remaining text', async () => {
		getSource().history(GENERAL);
		const before = bridge.edits.length;
		const answer = (await sdk.rest.post('/v1/chat.update', { msgId: MID, roomId: GENERAL, text: `[ ](http://h/channel/general?msg=%24m2)\nedited with a chip` })) as { message: { msg: string } };
		assert.deepEqual(bridge.edits.slice(before), [[GENERAL, MID, 'edited with a chip']]);
		assert.equal(answer.message.msg, 'edited with a chip');
	});

	it('POST chat.update maps the markup to CommonMark and edits with markdown: true (E1)', async () => {
		getSource().history(GENERAL);
		await sdk.rest.post('/v1/chat.update', { msgId: MID, roomId: GENERAL, text: '*now bold* and ~gone~' });
		assert.deepEqual(bridge.edits.at(-1), [GENERAL, MID, '**now bold** and <del>gone</del>']);
		assert.deepEqual(bridge.editOpts.at(-1), { markdown: true });
	});

	it('a received body is mapped back where the dialects disagree (E1): single * italic, del strike', () => {
		const m = bridge.timeline(GENERAL)[1];
		assert.equal(toMessage({ ...m, body: 'it *shows* and <del>that</del> and **bold**' }).msg, 'it _shows_ and ~that~ and **bold**');
	});

	it('POST chat.update calls editText with the Matrix event id and answers success; a refusal is Rocket.Chat\'s error and changes nothing', async () => {
		getSource().history(GENERAL);
		const answer = (await sdk.rest.post('/v1/chat.update', { msgId: MID, roomId: GENERAL, text: 'edited text' })) as { success: boolean };
		assert.equal(answer.success, true);
		assert.deepEqual(bridge.edits.at(-1), [GENERAL, MID, 'edited text']);
		assert.ok(answeredLog.includes('POST /v1/chat.update'));
		bridge.actionMode = 'reject';
		await assert.rejects(sdk.rest.post('/v1/chat.update', { msgId: '$m2', roomId: GENERAL, text: 'not mine' }), (e: Error & { success: boolean; errorType: string }) => e.success === false && e.errorType === 'error-forbidden');
		bridge.actionMode = 'ok';
		await assert.rejects(sdk.rest.post('/v1/chat.update', { msgId: '$nope', roomId: GENERAL, text: 'x' }), /Message not found/);
		assert.equal(getSource().message('$m2')?.msg, '🎉', 'the refused edit left the message as it was');
	});

	it('POST chat.delete redacts through the bridge; the row leaves when the redaction arrives, never before', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'message' && seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		b.actionMode = 'reject';
		await assert.rejects(src.deleteMessage(MID), /not allowed/);
		assert.deepEqual(seen, [], 'a refused delete leaves the message');
		assert.ok(src.history(GENERAL).some((m) => m._id === MID));
		b.actionMode = 'ok';
		await src.deleteMessage(MID);
		assert.deepEqual(b.deletes.at(-1), [GENERAL, MID]);
		assert.deepEqual(seen, [`removed:${MID}`]);
		assert.ok(!src.history(GENERAL).some((m) => m._id === MID), 'the redacted row is not listed again');
		assert.equal(src.message(MID), undefined);
	});

	it('the endpoint answers success and is recorded as answered', async () => {
		// A message of its own, so the shared fixture room keeps its messages for the other tests.
		await sdk.rest.post('/v1/chat.sendMessage', { message: { _id: 'rc-del', rid: GENERAL, msg: 'to be deleted' } });
		await new Promise((r) => setTimeout(r, 5));
		const answer = (await sdk.rest.post('/v1/chat.delete', { msgId: 'rc-del', roomId: GENERAL })) as { success: boolean; _id: string };
		assert.equal(answer.success, true);
		assert.equal(answer._id, 'rc-del');
		assert.equal(bridge.deletes.at(-1)?.[1], '$sent' + bridge.sent.length);
		assert.ok(answeredLog.includes('POST /v1/chat.delete'));
	});


	it('REQ-0008 V2: Custom_Translations replaces the three /home card strings that name the product, with neutral text', async () => {
		const settings = (await sdk.call('public-settings/get')) as Array<{ _id: string; value: unknown }>;
		const raw = settings.find((s) => s._id === 'Custom_Translations')?.value;
		assert.equal(typeof raw, 'string'); // RC's useCustomTranslations ignores anything but a JSON string
		const en = (JSON.parse(raw as string) as Record<string, Record<string, string>>).en;
		const keys = ['Take_rocket_chat_with_you_with_mobile_applications', 'Install_rocket_chat_on_your_preferred_desktop_platform', 'Learn_how_to_unlock_the_myriad_possibilities_of_rocket_chat'];
		assert.deepEqual(Object.keys(en).sort(), [...keys].sort());
		for (const k of keys) {
			assert.ok(en[k].length > 0, k);
			assert.doesNotMatch(en[k], /rocket\.?\s?chat|element/i, k);
		}
	});

	it('grants the settings and the permission Rocket.Chat\'s own Edit and Delete items read, for own messages only', async () => {
		const settings = (await sdk.call('public-settings/get')) as Array<{ _id: string; value: unknown }>;
		const value = (id: string) => settings.find((s) => s._id === id)?.value;
		assert.equal(value('Message_AllowEditing'), true);
		assert.equal(value('Message_AllowDeleting'), true);
		assert.equal(value('Message_AllowEditing_BlockEditInMinutes'), 0);
		const perms = ((await sdk.call('permissions/get')) as Array<{ _id: string }>).map((p) => p._id);
		assert.ok(perms.includes('delete-own-message'));
		assert.ok(!perms.includes('delete-message') && !perms.includes('edit-message'));
	});
});

describe('bridge lookup', () => {
	it('own window first, then the parent (a reload inside the frame), none in a frame without one', () => {
		const parentWin = { __clientViewBridge: bridge } as unknown as Window;
		const framed = { parent: parentWin } as unknown as Window;
		assert.equal(findBridge(framed), bridge);
		const own = { parent: parentWin, __clientViewBridge: fixtureBridge() } as unknown as Window;
		assert.notEqual(findBridge(own), bridge);
		assert.equal(findBridge({ parent: {} } as unknown as Window), undefined);
		const crossOrigin = { parent: new Proxy({}, { get: () => { throw new Error('SecurityError'); } }) } as unknown as Window;
		assert.equal(findBridge(crossOrigin), undefined);
	});
});

describe('reload path (D8)', () => {
	it('reads the Rocket.Chat path from the hash; no or a foreign hash = /home', () => {
		assert.deepEqual(parseHash('#/channel/general-chat?msg=1#x'), { pathname: '/channel/general-chat', search: '?msg=1', hash: '#x' });
		assert.deepEqual(parseHash(''), { pathname: '/home', search: '', hash: '' });
		assert.deepEqual(parseHash('#section'), { pathname: '/home', search: '', hash: '' });
		assert.deepEqual(parseHash('#//evil.example'), { pathname: '/home', search: '', hash: '' });
	});
});

describe('media bodies (increments 5-7)', () => {
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over }) as never;
	type Att = Record<string, unknown>;
	const attachments = (media: Record<string, unknown>) =>
		(toMessage(base({ media })) as unknown as { attachments: Att[]; msg: string }).attachments;

	it('an image is Rocket.Chat\'s image attachment: thumbnail as image_url, full image as the link, the frame size', () => {
		const [a] = attachments({ kind: 'image', state: 'ready', url: 'blob:full', thumbnailUrl: 'http://hs/thumb', name: 'cat.png', width: 320, height: 240 });
		assert.equal(a.type, 'file');
		assert.equal(a.image_url, 'http://hs/thumb');
		assert.equal(a.title_link, 'blob:full');
		assert.equal(a.title, 'cat.png');
		assert.deepEqual(a.image_dimensions, { width: 320, height: 240 });
	});

	it('an image without a thumbnail uses its URL; without a frame size it leaves Rocket.Chat\'s default', () => {
		const [a] = attachments({ kind: 'image', state: 'ready', url: 'blob:full', name: 'cat.png' });
		assert.equal(a.image_url, 'blob:full');
		assert.equal('image_dimensions' in a, false);
	});

	it('a video is Rocket.Chat\'s video attachment; a file is a file attachment with its title link', () => {
		const [v] = attachments({ kind: 'video', state: 'ready', url: 'http://hs/clip', name: 'clip.webm' });
		assert.equal(v.video_url, 'http://hs/clip');
		assert.equal(v.title, 'clip.webm');
		const [f] = attachments({ kind: 'file', state: 'ready', url: 'http://hs/notes', name: 'notes.txt (12 bytes)' });
		assert.equal(f.title, 'notes.txt (12 bytes)');
		assert.equal(f.title_link, 'http://hs/notes');
		assert.equal('image_url' in f || 'video_url' in f, false);
	});

	it('audio (a voice message too) is Rocket.Chat\'s audio attachment, played by its own audio element', () => {
		const [a] = attachments({ kind: 'audio', state: 'ready', url: 'blob:voice', name: 'Voice message' });
		assert.equal(a.type, 'file');
		assert.equal(a.audio_url, 'blob:voice');
		assert.equal(a.title, 'Voice message');
		assert.equal(a.title_link, 'blob:voice');
		assert.equal('image_url' in a || 'video_url' in a, false);
	});

	it('audio that is loading or in error is a plain file attachment with Element\'s text and no link', () => {
		for (const media of [
			{ kind: 'audio', state: 'loading', name: 'a.ogg' },
			{ kind: 'audio', state: 'error', name: 'a.ogg', label: 'Error processing audio message' },
		]) {
			const [a] = attachments(media);
			assert.equal(a.title, media.name);
			assert.equal('title_link' in a || 'audio_url' in a, false);
		}
	});

	it('an encrypted file, loading, hidden and error media are a plain file attachment with Element\'s text and no link', () => {
		for (const media of [
			{ kind: 'file', state: 'ready', name: 'secret.bin' },
			{ kind: 'image', state: 'loading', name: 'a.png' },
			{ kind: 'image', state: 'hidden', name: '', label: 'Show image' },
			{ kind: 'video', state: 'error', name: '', label: 'Error decrypting video' },
		]) {
			const [a] = attachments(media);
			assert.equal(a.type, 'file');
			assert.equal(a.title, media.name || media.label);
			assert.equal('title_link' in a || 'image_url' in a || 'video_url' in a, false);
		}
	});

	it('B7: an encrypted file that Element offers to download links its download scheme, a plain file keeps its URL', () => {
		const message = { rid: GENERAL, id: '$file', canDownload: true };
		const encrypted = mediaAttachment({ kind: 'file', state: 'ready', name: 'secret.bin' }, message) as Record<string, unknown>;
		assert.equal(encrypted.type, 'file');
		assert.equal(encrypted.title, 'secret.bin');
		assert.equal(encrypted.title_link, downloadHref(GENERAL, '$file'));
		assert.equal(encrypted.title_link_download, true);
		assert.deepEqual(parseDownloadHref(encrypted.title_link as string), { rid: GENERAL, id: '$file' });
		const plain = mediaAttachment({ kind: 'file', state: 'ready', name: 'a.txt', url: 'http://hs/a' }, message) as Record<string, unknown>;
		assert.equal(plain.title_link, 'http://hs/a');
		// Not offered, or not a ready file: no link.
		for (const [media, m] of [
			[{ kind: 'file', state: 'ready', name: 'secret.bin' }, { ...message, canDownload: false }],
			[{ kind: 'file', state: 'error', name: 'secret.bin' }, message],
			[{ kind: 'image', state: 'ready', name: 'a.png' }, message],
		] as const) {
			assert.equal('title_link' in (mediaAttachment(media, m) as object), false);
		}
	});

	it('B7: the download scheme round-trips ids with special characters and rejects any other href', () => {
		const rid = '!ab/cd:example.org';
		const id = '$e+v/e:n=t';
		assert.deepEqual(parseDownloadHref(downloadHref(rid, id)), { rid, id });
		for (const href of ['http://hs/a', 'evw-download:', 'evw-download:!a', 'evw-download:!a/$b/c', 'evw-download:%E0%A4%A/$b']) {
			assert.equal(parseDownloadHref(href), undefined);
		}
	});

	it('B7: a downloadable encrypted file is a file attachment with the download link in the message doc', () => {
		const doc = toMessage({ ...bridge.timeline(GENERAL)[0], id: '$file', roomId: GENERAL, body: 'secret.bin', media: { kind: 'file', state: 'ready', name: 'secret.bin' }, canDownload: true } as never) as unknown as { attachments: Array<{ title_link: string }> };
		assert.equal(doc.attachments[0].title_link, downloadHref(GENERAL, '$file'));
	});

	it('B7: the source hands the download to the bridge; a refusal is Rocket.Chat\'s error shape, a missing action unsupported', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.deepEqual(await src.download(GENERAL, '$file'), { status: 'done', roomId: GENERAL, eventId: '$file' });
		assert.deepEqual(b.downloads, [[GENERAL, '$file']]);
		await src.sendText(GENERAL, 'pic', 'rc-own-file');
		await src.download(GENERAL, 'rc-own-file');
		assert.deepEqual(b.downloads.at(-1), [GENERAL, '$sent1']);
		b.downloadResult = Object.assign(new Error('nothing to download'), { code: 'unsupported' });
		await assert.rejects(src.download(GENERAL, '$text'), { success: false });
		const old = fixtureBridge();
		delete (old as { download?: unknown }).download;
		await assert.rejects(new BridgeSource(old).download(GENERAL, '$file'), { code: 'unsupported' });
	});

	describe('M12 Z3: reveal hidden media', () => {
		const hidden = { kind: 'image', state: 'hidden', name: 'cat.png', label: 'Show image', width: 320, height: 240 };
		const host = { rid: GENERAL, id: '$img', canShowMedia: true };

		it('a hidden image on a host with showMedia is an image attachment with no URL, no link and the kit marker', () => {
			const a = mediaAttachment(hidden as never, host) as unknown as Att;
			assert.equal(a.type, 'file');
			assert.equal(a.image_url, '');
			assert.equal('title_link' in a, false);
			assert.deepEqual(a.kitHiddenMedia, { rid: GENERAL, eventId: '$img' });
			assert.deepEqual(a.image_dimensions, { width: 320, height: 240 });
		});

		it('a hidden image without showMedia and a hidden image that has a URL stay the plain file-name row (no marker; the hidden video is M13 U2)', () => {
			for (const [media, message] of [
				[hidden, { ...host, canShowMedia: false }],
				[hidden, { rid: GENERAL, id: '$img' }],
				[{ ...hidden, url: 'http://hs/x.png' }, host],
			] as const) {
				const a = mediaAttachment(media as never, message) as unknown as Att;
				assert.equal(a.type, 'file');
				assert.equal(a.title, 'cat.png');
				assert.equal('kitHiddenMedia' in a || 'image_url' in a || 'video_url' in a || 'title_link' in a, false);
			}
			assert.equal((mediaAttachment({ ...hidden, name: '' } as never, host) as unknown as Att).title, 'Show image');
		});

		const hiddenMessage = (b: ReturnType<typeof fixtureBridge>) =>
			b.putMessage(GENERAL, { ...b.timeline(GENERAL)[0], id: '$img', body: 'cat.png', media: hidden } as never);
		const attachmentsOf = (src: BridgeSource) =>
			(src.history(GENERAL).find((m) => m._id === '$img') as unknown as { attachments: Att[] }).attachments;

		it('the source marks a hidden image for a bridge with showMedia and not for an old bridge', () => {
			const b = fixtureBridge();
			hiddenMessage(b);
			assert.deepEqual(attachmentsOf(new BridgeSource(b))[0].kitHiddenMedia, { rid: GENERAL, eventId: '$img' });
			const old = fixtureBridge();
			delete (old as { showMedia?: unknown }).showMedia;
			hiddenMessage(old);
			const [a] = attachmentsOf(new BridgeSource(old));
			assert.equal('kitHiddenMedia' in a, false);
			assert.equal('image_url' in a, false);
		});

		it('the source hands the reveal to the bridge, the image arrives with the next snapshot, and it shows no marker then', async () => {
			const b = fixtureBridge();
			hiddenMessage(b);
			const src = new BridgeSource(b);
			assert.equal(src.canShowMedia, true);
			assert.deepEqual(await src.showMedia(GENERAL, '$img'), { status: 'done', roomId: GENERAL, eventId: '$img' });
			assert.deepEqual(b.mediaReveals, [[GENERAL, '$img']]);
			const [a] = attachmentsOf(src);
			assert.equal(a.image_url, 'http://hs/revealed.png');
			assert.equal('kitHiddenMedia' in a, false);
		});

		it('a refusal is Rocket.Chat\'s error shape and the box stays; an unknown event is refused; a missing action is unsupported', async () => {
			const b = fixtureBridge();
			hiddenMessage(b);
			const src = new BridgeSource(b);
			b.showMediaResult = Object.assign(new Error('nope'), { code: 'failed' });
			await assert.rejects(src.showMedia(GENERAL, '$img'), { success: false });
			assert.deepEqual(attachmentsOf(src)[0].kitHiddenMedia, { rid: GENERAL, eventId: '$img' });
			b.showMediaResult = undefined;
			await assert.rejects(src.showMedia(GENERAL, '$gone'), { success: false });
			assert.deepEqual(attachmentsOf(src)[0].kitHiddenMedia, { rid: GENERAL, eventId: '$img' });
			const old = fixtureBridge();
			delete (old as { showMedia?: unknown }).showMedia;
			assert.equal(new BridgeSource(old).canShowMedia, false);
			await assert.rejects(new BridgeSource(old).showMedia(GENERAL, '$img'), { code: 'unsupported' });
		});

		it('an own-sent id maps through eventIdOf to the Matrix event id', async () => {
			const b = fixtureBridge();
			const src = new BridgeSource(b);
			await src.sendText(GENERAL, 'pic', 'rc-own-img');
			// The fixture refuses an event it has no hidden image for; the call it recorded carries the Matrix id.
			await assert.rejects(src.showMedia(GENERAL, 'rc-own-img'), { success: false });
			assert.deepEqual(b.mediaReveals.at(-1), [GENERAL, '$sent1']);
		});
	});

	it('a media message has no text of its own (the body is the file name) and keeps a quote before its attachment', () => {
		const reply = { eventId: '$p', senderId: '@bob:example.org', senderName: 'Bob', text: 'q' };
		const doc = toMessage(base({ body: 'cat.png', media: { kind: 'image', state: 'ready', url: 'blob:x', name: 'cat.png' }, replyTo: reply })) as unknown as { msg: string; attachments: Att[] };
		assert.equal(doc.msg, '');
		assert.equal(doc.attachments.length, 2);
		assert.equal(doc.attachments[0].author_name, 'Bob');
		assert.equal(doc.attachments[1].image_url, 'blob:x');
		assert.equal(mediaAttachment(undefined), undefined);
	});

	it('the source re-renders the row when the media gets its URL', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		b.timeline(GENERAL)[0].media = { kind: 'image', state: 'ready', url: 'blob:x', name: 'a.png' };
		b.emit({ kind: 'timeline', roomId: GENERAL });
		const doc = changes.find((c) => c.kind === 'message')?.doc as { attachments: Att[] };
		assert.equal(doc.attachments[0].image_url, 'blob:x');
	});
});

describe('URL previews', () => {
	const preview = {
		link: 'https://example.org/post',
		title: 'A post',
		siteName: 'Example',
		description: 'About a post',
		image: { url: 'http://hs/thumb', width: 320, height: 180 },
	};
	const base = (over: Record<string, unknown> = {}) => ({ ...bridge.timeline(GENERAL)[0], ...over }) as never;
	type Doc = { urls?: Array<{ url: string; meta: Record<string, string> }>; msg: string };

	it('is a Rocket.Chat URL entry with the open-graph meta its link preview reads', () => {
		const doc = toMessage(base({ body: 'see https://example.org/post', urlPreviews: [preview] })) as unknown as Doc;
		assert.equal(doc.msg, 'see https://example.org/post');
		assert.deepEqual(doc.urls, [
			{
				url: 'https://example.org/post',
				meta: {
					ogTitle: 'A post',
					ogSiteName: 'Example',
					ogUrl: 'https://example.org/post',
					ogDescription: 'About a post',
					ogImage: 'http://hs/thumb',
					ogImageWidth: '320',
					ogImageHeight: '180',
				},
			},
		]);
	});

	it('links the site name where Element navigates (the preview link), never the sender\'s og:url, and leaves out what it lacks', () => {
		const [u] = urlsOf(base({ urlPreviews: [{ link: 'https://e.org/x', title: 'T', siteName: '', ogUrl: 'https://e.org/' }] }))!;
		assert.deepEqual(u, { url: 'https://e.org/x', meta: { ogTitle: 'T', ogUrl: 'https://e.org/x' } });
	});

	it('keeps sender-controlled preview fields out of Rocket.Chat\'s footer markdown (grok inc 8/4 F1)', () => {
		// Rocket.Chat renders the footer as markdown `[siteName](ogUrl)`: a crafted og:url or site name must not become a
		// foreign link or a remote image.
		const [u] = urlsOf(
			base({
				urlPreviews: [
					{
						link: 'https://github.com/a_(b)',
						title: 'T',
						siteName: 'git](https://evil.example/x) ![.](https://evil.example/p.png) [hub',
						ogUrl: 'https://evil.example/x) ![.](https://evil.example/p.png)',
					},
				],
			}),
		)!;
		assert.equal(u.meta.ogUrl, 'https://github.com/a_%28b%29');
		assert.doesNotMatch(u.meta.ogSiteName, /[[\]()!<>]/);
		assert.equal(u.meta.ogSiteName.includes('evil.example/p.png'), true, 'the text stays readable, only markdown syntax goes');
		const [bad] = urlsOf(base({ urlPreviews: [{ link: 'javascript:alert(1)', title: 'T', siteName: 'S' }] }))!;
		assert.equal('ogUrl' in bad.meta, false, 'a non-http link gets no site link');
	});

	it('a message without previews has no urls field at all (previews hidden by Element mean none)', () => {
		assert.equal('urls' in (toMessage(base()) as object), false);
		assert.equal('urls' in (toMessage(base({ urlPreviews: [] })) as object), false);
		assert.equal(urlsOf(base()), undefined);
	});

	it('Rocket.Chat\'s link previews are on (its UrlPreviews render only with the API_Embed setting)', async () => {
		const settings = (await sdk.call('public-settings/get')) as Array<{ _id: string; value: unknown }>;
		assert.equal(settings.find((s) => s._id === 'API_Embed')?.value, true);
	});

	it('the source re-renders the row when a preview arrives', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		src.rooms();
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		b.timeline(GENERAL)[0].urlPreviews = [preview];
		b.emit({ kind: 'timeline', roomId: GENERAL });
		const doc = changes.find((c) => c.kind === 'message')?.doc as Doc;
		assert.equal(doc.urls?.[0].url, 'https://example.org/post');
	});
});

describe('older history (A4)', () => {
	const old = (id: string, minAgo: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: id, ts: Date.now() - minAgo * 60_000, kind: 'text' as const });
	const collectChanges = (src: InstanceType<typeof BridgeSource>) => {
		const seen: string[] = [];
		src.onChange((c) => seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		return seen;
	};

	it('the first page answers a cursor at the oldest loaded message, a cursor past every message when none is loaded yet', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		assert.deepEqual(first.messages.map((m) => m._id), ['$m1', '$m2']);
		assert.equal(first.previous, new Date(first.messages[0].ts).toISOString());
		// Nothing loaded yet: Rocket.Chat asks again at once, and that answer waits for the host (here: its start).
		const none = await src.historyBefore('!empty:example.org');
		assert.deepEqual(none.messages, []);
		assert.ok(none.previous && Date.parse(none.previous) > Date.now() + 1e11);
		assert.deepEqual(await src.historyBefore('!empty:example.org', none.previous), { messages: [], previous: null });
		// Messages that arrive while the host loads are answered, not streamed as new ones.
		b.olderPages['!late:example.org'] = [[{ ...old('$l1', 5), roomId: '!late:example.org' }]];
		b.olderResult = { atStart: true };
		const late = await src.historyBefore('!late:example.org', none.previous);
		assert.deepEqual(late.messages.map((m) => m._id), ['$l1']);
		assert.equal(late.previous, null);
	});

	it('a request with the cursor loads older messages, answers them with a new cursor and does not stream them as new', async () => {
		const b = fixtureBridge();
		b.olderPages[GENERAL] = [[old('$o2', 30), old('$o3', 31)], [old('$o1', 60)]];
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		const seen = collectChanges(src);
		const page = await src.historyBefore(GENERAL, first.previous!);
		assert.deepEqual(page.messages.map((m) => m._id), ['$o3', '$o2']);
		assert.equal(page.previous, new Date(page.messages[0].ts).toISOString());
		assert.deepEqual(seen, []);
		assert.deepEqual(b.olderCalls, [GENERAL]);
		const last = await src.historyBefore(GENERAL, page.previous!);
		assert.deepEqual(last.messages.map((m) => m._id), ['$o1']);
		assert.equal(last.previous, null, 'the host reached the start of the room: Rocket.Chat asks no more');
	});

	it('answers the older messages the same call loaded and the cursor null when the page is the start', async () => {
		const b = fixtureBridge();
		b.olderPages[GENERAL] = [[old('$o1', 30)]];
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		const page = await src.historyBefore(GENERAL, first.previous!);
		assert.deepEqual([page.messages.map((m) => m._id), page.previous], [['$o1'], null]);
	});

	it('stops at the window limit; fails (cursor kept) after three pages that brought nothing, and a later ask loads', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		b.olderResult = { atStart: false };
		b.olderPages[GENERAL] = [[], [], [], [old('$o1', 30)]];
		await assert.rejects(src.historyBefore(GENERAL, first.previous!), { message: /could not be loaded/ });
		assert.equal(b.olderCalls.length, 3);
		// While the host is failing, Rocket.Chat's repeated asks are refused at once (no request storm), until the pause is over.
		await assert.rejects(src.historyBefore(GENERAL, first.previous!), { message: /could not be loaded/ });
		assert.equal(b.olderCalls.length, 3);
		src.olderRetryAfterMs = 0;
		const retry = await src.historyBefore(GENERAL, first.previous!);
		assert.deepEqual(retry.messages.map((m) => m._id), ['$o1']);
		const limited = fixtureBridge();
		limited.olderResult = { atStart: false, atLimit: true };
		const src2 = new BridgeSource(limited);
		const first2 = await src2.historyBefore(GENERAL);
		assert.deepEqual(await src2.historyBefore(GENERAL, first2.previous!), { messages: [], previous: null });
		assert.equal(limited.olderCalls.length, 1);
	});

	// M9 Q1: the quote click on a message not loaded yet (chat.getMessage pages back; rooms.history aroundId answers the window).
	it('ensureMessage pages older history in until the message is loaded; undefined at the start or the window limit', async () => {
		const b = fixtureBridge();
		b.olderPages[GENERAL] = [[old('$o2', 30)], [old('$o1', 60)]];
		const src = new BridgeSource(b);
		src.history(GENERAL);
		assert.equal((await src.ensureMessage(GENERAL, '$o1'))?._id, '$o1');
		assert.equal(b.olderCalls.length, 2);
		assert.equal((await src.ensureMessage(GENERAL, '$o1'))?._id, '$o1', 'loaded already: no further page');
		assert.equal(b.olderCalls.length, 2);
		b.olderResult = { atStart: true };
		assert.equal(await src.ensureMessage(GENERAL, '$nope'), undefined);
		const limited = fixtureBridge();
		limited.olderResult = { atStart: false, atLimit: true };
		const src2 = new BridgeSource(limited);
		src2.history(GENERAL);
		assert.equal(await src2.ensureMessage(GENERAL, '$nope'), undefined);
		assert.equal(limited.olderCalls.length, 1);
	});

	it('the jump window is every loaded message with a previous cursor and no newer side to page', async () => {
		const b = fixtureBridge();
		b.olderPages[GENERAL] = [[old('$o1', 30)]];
		const src = new BridgeSource(b);
		await src.ensureMessage(GENERAL, '$o1');
		const w = src.windowAround(GENERAL);
		assert.deepEqual(w.messages.map((m) => m._id), ['$o1', '$m1', '$m2']);
		assert.equal(w.previous, new Date(w.messages[0].ts).toISOString());
		assert.equal(src.windowAround('!empty:example.org').previous, null);
	});

	it('an older event that carries a later time than the cursor is history, not a new message (grok F3)', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		const seen = collectChanges(src);
		// Older in the timeline (before the loaded messages), but its time is later than the cursor's.
		b.olderPages[GENERAL] = [[old('$o1', 30), { ...old('$skew', 0), ts: Date.parse(first.previous!) + 5000 }]];
		const page = await src.historyBefore(GENERAL, first.previous!);
		assert.deepEqual(page.messages.map((m) => m._id), ['$o1', '$skew']);
		assert.deepEqual(seen, [], 'neither is streamed as a new message');
		assert.equal(page.previous, null, 'the host is at the start');
		// Not at the start: the cursor moves back to the oldest of the page, never forward.
		const b2 = fixtureBridge();
		const src2 = new BridgeSource(b2);
		const f2 = await src2.historyBefore(GENERAL);
		b2.olderResult = { atStart: false };
		b2.olderPages[GENERAL] = [[{ ...old('$skew', 0), ts: Date.parse(f2.previous!) + 5000 }]];
		const p2 = await src2.historyBefore(GENERAL, f2.previous!);
		assert.deepEqual(p2.messages.map((m) => m._id), ['$skew']);
		assert.equal(p2.previous, f2.previous);
		// It is answered once: the next ask loads another page.
		b2.olderPages[GENERAL] = [[old('$o1', 30)]];
		const p3 = await src2.historyBefore(GENERAL, p2.previous!);
		assert.deepEqual(p3.messages.map((m) => m._id), ['$o1']);
	});

	it('a room whose history stops before its creation event ends cleanly instead of failing every pause (grok F2)', async () => {
		const b = fixtureBridge();
		// The host reports atStart (no backward pagination left) without any older message.
		b.olderResult = { atStart: true };
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		for (let i = 0; i < 3; i++) assert.deepEqual(await src.historyBefore(GENERAL, first.previous!), { messages: [], previous: null });
		assert.equal(b.olderCalls.length, 3, 'one host call per ask, no retry loop, no failure pause');
	});

	it('a host that gives no ids falls back to position: messages before the first known one are history', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		const seen = collectChanges(src);
		b.olderResult = { atStart: false, ids: undefined };
		b.olderPages[GENERAL] = [[old('$o1', 30)]];
		const page = await src.historyBefore(GENERAL, first.previous!);
		assert.deepEqual(page.messages.map((m) => m._id), ['$o1']);
		assert.deepEqual(seen, []);
	});

	it('a live message that arrives while older ones load is streamed', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const first = await src.historyBefore(GENERAL);
		const seen = collectChanges(src);
		b.olderPages[GENERAL] = [[old('$o1', 30)]];
		const load = src.loadOlder(GENERAL);
		b.timeline(GENERAL).push({ ...old('$live', 0), ts: Date.now() });
		b.emit({ kind: 'timeline', roomId: GENERAL });
		await load;
		assert.deepEqual(seen, ['changed:$live']);
		assert.ok(first.previous);
	});

	it('serves the rooms.history endpoint with the cursor, and rejects a bad one the Rocket.Chat way', async () => {
		const first = (await sdk.rest.get('/v1/rooms.history', { roomId: RANDOM })) as { messages: { _id: string }[]; cursor: { previous: string | null } };
		assert.deepEqual(first.messages.map((m) => m._id), ['$m3']);
		assert.ok(first.cursor.previous);
		bridge.olderPages[RANDOM] = [[{ ...old('$r0', 90), roomId: RANDOM }]];
		const page = (await sdk.rest.get('/v1/rooms.history', { roomId: RANDOM, previous: first.cursor.previous })) as { messages: { _id: string }[]; cursor: { previous: string | null }; success: boolean };
		assert.deepEqual(page.messages.map((m) => m._id), ['$r0']);
		assert.deepEqual([page.cursor.previous, page.success], [null, true]);
		await assert.rejects(sdk.rest.get('/v1/rooms.history', { roomId: RANDOM, previous: 'nonsense' }), { success: false });
	});
});

describe('rooms: join, invites, create, chat, leave (A5-A7)', () => {
	const opened: string[] = [];
	const replaced: boolean[] = []; // per open: did it replace the current history entry
	setRoomOpener((rid: string, replace?: boolean) => void (opened.push(rid), replaced.push(!!replace)));
	const fresh = () => {
		const b = fixtureBridge();
		return { b, src: new BridgeSource(b) };
	};
	const collectChanges = (src: InstanceType<typeof BridgeSource>) => {
		const seen: string[] = [];
		src.onChange((c) => seen.push(`${c.op}:${c.kind}:${(c.doc as { _id: string })._id}`));
		return seen;
	};

	beforeEach(() => {
		stubLog.length = 0;
		answeredLog.length = 0;
		opened.length = 0;
		replaced.length = 0;
		bridge.joins.length = 0;
		bridge.invites.length = 0;
		bridge.roomResult = {};
	});

	it('an invited room is Rocket.Chat\'s invite subscription (status INVITED, an inviter naming the room); a joined one is not', () => {
		const b = fixtureBridge();
		b.rooms()[1].membership = 'invite';
		const src = new BridgeSource(b);
		const invited = src.subscriptions().find((s) => s.rid === RANDOM) as unknown as { status?: string; inviter?: { name: string } };
		assert.equal(invited.status, 'INVITED');
		assert.equal(invited.inviter?.name, 'Random');
		assert.equal((src.subscriptions().find((s) => s.rid === GENERAL) as unknown as { status?: string }).status, undefined);
		// accepting flips the subscription back to a joined one (the invite screen goes away)
		const seen = collectChanges(src);
		void b.acceptInvite(RANDOM);
		assert.equal((src.subscriptions().find((s) => s.rid === RANDOM) as unknown as { status?: string }).status, undefined);
		assert.ok(seen.includes(`changed:subscription:s-${RANDOM}`), seen.join(','));
	});

	it('POST rooms.invite accepts and rejects through the bridge; another action is refused the Rocket.Chat way', async () => {
		await sdk.rest.post('/v1/rooms.invite', { roomId: RANDOM, action: 'accept' });
		await sdk.rest.post('/v1/rooms.invite', { roomId: RANDOM, action: 'reject' });
		assert.deepEqual(bridge.invites, [
			{ op: 'accept', roomId: RANDOM },
			{ op: 'decline', roomId: RANDOM },
		]);
		assert.deepEqual(answeredLog, ['POST /v1/rooms.invite', 'POST /v1/rooms.invite']);
		await assert.rejects(sdk.rest.post('/v1/rooms.invite', { roomId: RANDOM, action: 'nonsense' }), { success: false });
	});

	it('an exact #alias:server search lists the one room to join; any other search stays unanswered', async () => {
		const type = JSON.stringify({ users: false, rooms: true, includeFederatedRooms: true });
		const found = (await sdk.rest.get('/v1/spotlight', { query: 'lobby:example.org', type })) as { users: unknown[]; rooms: { _id: string; t: string; name: string; fname: string }[] };
		assert.equal(found.users.length, 0);
		assert.deepEqual(found.rooms.map((r) => [r._id, r.t, r.fname]), [['#lobby:example.org', 'c', '#lobby:example.org']]);
		// M10 W5: any other lookup (the sidebar's, rooms and users) is answered with empty server lists, never rejected or searched
		const empty = { users: [], rooms: [], success: true };
		assert.deepEqual(await sdk.rest.get('/v1/spotlight', { query: 'lobby', type }), empty);
		assert.deepEqual(await sdk.rest.get('/v1/spotlight', { query: 'lobby:example.org', type: JSON.stringify({ users: true, rooms: true, includeFederatedRooms: true }) }), empty);
		assert.deepEqual(await sdk.rest.get('/v1/spotlight', { query: 'bob', usernames: '', type: JSON.stringify({ users: true, rooms: false }) }), empty);
		assert.deepEqual(await sdk.rest.get('/v1/spotlight', { query: 'lobby' }), empty);
		assert.equal(stubLog.length, 0, 'no unanswered call is left: the sidebar lookup is answered');
		// the looked-up room opens as an unjoined room, by its route name; an unknown name stays unanswered
		const room = (await sdk.call('getRoomByTypeAndName', 'c', found.rooms[0].name)) as { _id: string; t: string };
		assert.deepEqual([room._id, room.t], ['#lobby:example.org', 'c']);
		await assert.rejects(sdk.call('getRoomByTypeAndName', 'c', 'never-looked-up'));
		await assert.rejects(sdk.call('getRoomByTypeAndName', 'd', found.rooms[0].name));
	});

	it('POST rooms.join joins by the looked-up address, then opens the joined room; a refusal is Rocket.Chat\'s error and opens nothing', async () => {
		await sdk.rest.post('/v1/rooms.join', { roomId: '#lobby:example.org' });
		assert.deepEqual(bridge.joins, ['#lobby:example.org']);
		assert.deepEqual(opened, ['#lobby:example.org']);
		assert.deepEqual(replaced, [true], 'the join replaces the address route in the history (Back goes to the page before it)');
		bridge.roomResult.join = Object.assign(new Error('no such room'), { code: 'unknown_room' });
		await assert.rejects(sdk.rest.post('/v1/rooms.join', { roomId: '#nope:example.org' }), { success: false, errorType: 'error-unknown_room' });
		assert.deepEqual(opened, ['#lobby:example.org']);
	});

	it('after a join by address, searching it lists the real room and its address route leads to that room, not to the not-joined screen', async () => {
		const type = JSON.stringify({ users: false, rooms: true, includeFederatedRooms: true });
		const search = async (q: string) => ((await sdk.rest.get('/v1/spotlight', { query: q, type })) as { rooms: { _id: string; name: string; fname: string }[] }).rooms[0];
		const before = await search('hall:example.org');
		assert.equal(before._id, '#hall:example.org');
		assert.equal(((await sdk.call('getRoomByTypeAndName', 'c', before.name)) as { _id: string })._id, '#hall:example.org', 'not joined yet: the not-joined room');
		bridge.roomResult.join = { roomId: GENERAL };
		await sdk.rest.post('/v1/rooms.join', { roomId: '#hall:example.org' });
		assert.deepEqual([opened, replaced], [[GENERAL], [true]]);
		// Searching the address again lists the real room (its id, its route name) under a title that matches the query.
		const after = await search('hall:example.org');
		assert.equal(after._id, GENERAL);
		assert.equal(after.name, getSource().room(GENERAL)!.name, 'the route name is the real room\'s');
		assert.equal(after.fname, '#hall:example.org');
		// ... and the row survives the sidebar search's own filter (useSearchItems: the typed text, minus # or @, as a
		// case-insensitive regex over name and fname) and its dedup (a subscription with the row's id among the matching ones).
		const typed = '#hall:example.org';
		const filterRegex = new RegExp(typed.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
		const matches = ({ name, fname }: { name?: string; fname?: string }) => (name && filterRegex.test(name)) || (fname && filterRegex.test(fname));
		assert.ok(matches(after), 'the row matches the typed address');
		const local = getSource().subscriptions().filter((sub) => matches(sub as unknown as { name?: string; fname?: string }));
		assert.ok(!local.some((sub) => [sub.rid, sub._id].includes(after._id)), 'no matching local subscription of that room drops the row');
		// Back / a reload of the address route: the real room, and the route moves on to it in place of itself
		const again = (await sdk.call('getRoomByTypeAndName', 'c', before.name)) as { _id: string };
		assert.equal(again._id, GENERAL);
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual([opened, replaced], [[GENERAL, GENERAL], [true, true]]);
	});

	it('a peeked room (M10 W1: a Directory pick Element only previews) opens the not-joined screen by its id, and the Join button joins it', async () => {
		const peek = '!peeked:example.org';
		assert.equal(getSource().room(peek), undefined, 'not one of the kit\'s rooms');
		const { rid, name } = openPreview(peek);
		assert.equal(rid, peek);
		const room = (await sdk.call('getRoomByTypeAndName', 'c', name)) as { _id: string; t: string; fname: string };
		assert.deepEqual([room._id, room.t, room.fname], [peek, 'c', peek], 'the not-joined room, titled by its id (the bridge gives no name for a peek)');
		assert.equal(openPreview(peek).name, name, 'the same room keeps its route name');
		await sdk.rest.post('/v1/rooms.join', { roomId: room._id });
		assert.deepEqual(bridge.joins, [peek]);
		assert.deepEqual([opened, replaced], [[peek], [true]], 'the join opens the real room in place of the preview');
		assert.ok(getSource().room(peek), 'the joined room is one of the kit\'s rooms');
	});

	it('two addresses that slug alike get distinct route names, each leading to its own address', async () => {
		const type = JSON.stringify({ users: false, rooms: true, includeFederatedRooms: true });
		const search = async (q: string) => ((await sdk.rest.get('/v1/spotlight', { query: q, type })) as { rooms: { _id: string; name: string }[] }).rooms[0];
		const dots = await search('room:example.com');
		const dash = await search('room:example-com');
		assert.notEqual(dots.name, dash.name);
		assert.equal(((await sdk.call('getRoomByTypeAndName', 'c', dots.name)) as { _id: string })._id, '#room:example.com');
		assert.equal(((await sdk.call('getRoomByTypeAndName', 'c', dash.name)) as { _id: string })._id, '#room:example-com');
		assert.equal((await search('room:example.com')).name, dots.name, 'the same address keeps its route name');
	});

	it('creating a room is done once the kit has the room; a closed dialog is cancelled; a failure is Rocket.Chat\'s error shape', async () => {
		const { b, src } = fresh();
		const done = await src.createRoom();
		assert.deepEqual(done, { status: 'done', roomId: '!created:example.org' });
		assert.ok(src.room('!created:example.org'), 'the room is in the kit before the outcome is handed on');
		b.roomResult.createRoom = { status: 'cancelled' };
		assert.deepEqual(await src.createRoom(), { status: 'cancelled' });
		b.roomResult.createRoom = Object.assign(new Error('Element could not create the room'), { code: 'failed' });
		await assert.rejects(src.createRoom(), { success: false, errorType: 'error-failed' });
		assert.equal(src.rooms().filter((r) => r._id === '!created:example.org').length, 1, 'a failed create leaves no second room');
	});

	it('starting a chat lists the local room first and hands its id on; cancelled lists nothing', async () => {
		const { b, src } = fresh();
		const out = await src.createChat();
		assert.deepEqual(out, { status: 'done', roomId: 'local+dm' });
		assert.equal(src.room('local+dm')?.t, 'd');
		b.roomResult.createChat = { status: 'cancelled' };
		assert.deepEqual(await src.createChat(), { status: 'cancelled' });
		assert.deepEqual(b.creates, ['chat', 'chat']);
	});

	it('the Directory pick (openDirectory, bridge version 4) passes the options on and is done once the kit has the joined room', async () => {
		const { b, src } = fresh();
		const out = await src.openDirectory({ filter: 'rooms' });
		assert.deepEqual(out, { status: 'done', roomId: '!directory:example.org' });
		assert.ok(src.room('!directory:example.org'), 'the room is in the kit before the outcome is handed on (the navigation can open it)');
		await src.openDirectory({ term: 'ops', filter: 'people' });
		await src.openDirectory();
		assert.deepEqual(b.directoryCalls, [{ filter: 'rooms' }, { term: 'ops', filter: 'people' }, undefined]);
	});

	it('a peek pick (a world-readable room Element only previews) is handed on at once: the room never reaches the list, the call must not wait for it', async () => {
		const { b, src } = fresh();
		b.roomResult.openDirectory = { roomId: '!peek:example.org', peek: true };
		const started = Date.now();
		const out = await src.openDirectory({ filter: 'rooms' });
		assert.deepEqual(out, { status: 'done', roomId: '!peek:example.org', peek: true });
		assert.ok(Date.now() - started < 2_000, 'no wait on roomShown (10 s) for a room that is not joined');
		assert.equal(src.room('!peek:example.org'), undefined, 'a peeked room is not one of the kit\'s rooms');
	});

	it('a closed Directory is cancelled; a failure is Rocket.Chat\'s error shape and lists nothing', async () => {
		const { b, src } = fresh();
		b.roomResult.openDirectory = { status: 'cancelled' };
		assert.deepEqual(await src.openDirectory({ filter: 'rooms' }), { status: 'cancelled' });
		b.roomResult.openDirectory = Object.assign(new Error('Element could not join the room'), { code: 'failed' });
		await assert.rejects(src.openDirectory({ filter: 'rooms' }), { success: false, errorType: 'error-failed' });
		assert.equal(src.room('!directory:example.org'), undefined);
	});

	it('M11 Y1: a dialog-busy failure from another realm (a plain object, not an Error instance: the kit runs in an iframe) shows the same sentence', async () => {
		const crossRealm = { code: 'failed', message: 'another Element dialog action is running' };
		assert.equal(crossRealm instanceof Error, false, 'the fixture is not an Error of this realm');
		assert.equal(isDialogBusy(crossRealm), true);
		assert.equal(isDialogBusy({ code: 'failed', message: 'Element could not join the room' }), false);
		const { b, src } = fresh();
		// The fixture bridge throws only a same-realm Error (`instanceof Error`), so the host's rejection is thrown by hand here.
		const openDirectory = b.openDirectory;
		b.openDirectory = async () => { throw crossRealm; };
		await assert.rejects(src.openDirectory({ term: 'ops', filter: 'rooms' }), { success: false, errorType: 'error-failed', error: DIALOG_BUSY, message: DIALOG_BUSY });
		b.openDirectory = openDirectory;
	});

	it('M11 Y1: the host\'s dialog-busy failure is one plain sentence on every dialog-opening action, any other failure keeps its own text', async () => {
		const busy = (): Error => Object.assign(new Error('another Element dialog action is running'), { code: 'failed' });
		const plain = { success: false, errorType: 'error-failed', error: DIALOG_BUSY, message: DIALOG_BUSY };
		const { b, src } = fresh();
		b.roomResult.openDirectory = busy();
		await assert.rejects(src.openDirectory({ term: 'ops', filter: 'rooms' }), plain);
		b.roomResult.openDirectory = undefined;
		b.roomResult.createRoom = busy();
		await assert.rejects(src.createRoom(), plain);
		b.roomResult.createRoom = undefined;
		b.roomResult.leave = busy();
		await assert.rejects(src.leave(GENERAL), plain);
		assert.ok(src.room(GENERAL), 'a refused leave leaves the room in the list');
		b.roomResult.leave = undefined;
		// The sentence is plain: no host wording, and it names no raw error.
		assert.doesNotMatch(DIALOG_BUSY, /dialog action|ClientViewActionError|another Element/);
		assert.equal(isDialogBusy(busy()), true);
		assert.equal(isDialogBusy(new Error('Element could not join the room')), false);
		assert.equal(isDialogBusy(null), false);
		assert.equal(isDialogBusy(undefined), false);
		b.roomResult.openDirectory = Object.assign(new Error('Element could not join the room'), { code: 'failed' });
		await assert.rejects(src.openDirectory({ filter: 'rooms' }), { error: 'Element could not join the room' });
		b.roomResult.openDirectory = undefined;
		assert.equal((await src.openDirectory({ filter: 'rooms' })).status, 'done', 'the next call after the window works');
	});

	it('M11 Y1: any other failure from another realm (a plain object, not an Error) shows its message, never `ClientViewActionError: ...`', async () => {
		const crossRealm = { name: 'ClientViewActionError', message: 'x', code: 'failed' };
		assert.equal(crossRealm instanceof Error, false, 'the fixture is not an Error of this realm');
		const { b, src } = fresh();
		b.openDirectory = async () => { throw crossRealm; };
		await assert.rejects(src.openDirectory({ filter: 'rooms' }), { success: false, errorType: 'error-failed', error: 'x', message: 'x' });
		// A thrown value without a string message keeps String(value).
		b.openDirectory = async () => { throw 'plain text'; };
		await assert.rejects(src.openDirectory({ filter: 'rooms' }), { error: 'plain text', message: 'plain text' });
	});

	it('a host without the Directory action (bridge version 2 or 3) rejects it as unsupported, the other room actions keep working', async () => {
		const b = fixtureBridge();
		Object.assign(b, { openDirectory: undefined, version: 3 });
		const src = new BridgeSource(b);
		await assert.rejects(src.openDirectory({ filter: 'rooms' }), { code: 'unsupported' });
		assert.deepEqual(b.directoryCalls, []);
		assert.equal((await src.createChat()).status, 'done');
	});

	it('the direct chat (startDm, M11 Y4) passes the user id on and is done once the kit has the room', async () => {
		const { b, src } = fresh();
		assert.equal(src.canStartDm(), true);
		const out = await src.startDm('@dave:example.org');
		assert.deepEqual(out, { status: 'done', roomId: '!dm-dave:example.org' });
		assert.equal(src.room('!dm-dave:example.org')?.t, 'd', 'the chat is in the kit before the outcome is handed on (the navigation can open it)');
		await src.startDm('@erin:example.org');
		assert.deepEqual(b.dmCalls, ['@dave:example.org', '@erin:example.org']);
	});

	it('the room of the message (M12 Z2 F1) reaches the bridge as the second argument, and is absent when not given', async () => {
		const { b, src } = fresh();
		await src.startDm('@dave:example.org', '!here:example.org');
		await src.startDm('@erin:example.org');
		assert.deepEqual(b.dmFromRooms, ['!here:example.org', undefined]);
	});

	it('an existing chat answers with its own room and adds no second one', async () => {
		const { b, src } = fresh();
		b.roomResult.startDm = { roomId: '!bob:example.org' };
		const before = src.rooms().length;
		assert.deepEqual(await src.startDm('@bob:example.org'), { status: 'done', roomId: '!bob:example.org' });
		assert.equal(src.rooms().length, before);
		assert.deepEqual(b.dmCalls, ['@bob:example.org']);
	});

	it('a backed-out chat is cancelled; a failure is Rocket.Chat\'s error shape and lists nothing', async () => {
		const { b, src } = fresh();
		b.roomResult.startDm = { status: 'cancelled' };
		assert.deepEqual(await src.startDm('@dave:example.org'), { status: 'cancelled' });
		b.roomResult.startDm = Object.assign(new Error('Element could not start the chat'), { code: 'failed' });
		await assert.rejects(src.startDm('@dave:example.org'), { success: false, errorType: 'error-failed' });
		assert.equal(src.room('!dm-dave:example.org'), undefined);
	});

	it('a host without startDm (before M11 Y4) offers no direct chat: canStartDm is false and the call rejects as unsupported, the other room actions keep working', async () => {
		const b = fixtureBridge();
		Object.assign(b, { startDm: undefined });
		const src = new BridgeSource(b);
		assert.equal(src.canStartDm(), false);
		await assert.rejects(src.startDm('@dave:example.org'), { code: 'unsupported' });
		assert.deepEqual(b.dmCalls, []);
		assert.equal((await src.createChat()).status, 'done');
	});

	it('the kit accepts bridge versions 1 to 8 and nothing else', () => {
		for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(supportedBridgeVersion(v), true, `version ${v}`);
		for (const v of [0, 9, '6', undefined]) assert.equal(supportedBridgeVersion(v), false, `version ${String(v)}`);
		assert.equal(supportedBridgeVersion(fixtureBridge().version), true, 'the fixture answers a supported version');
	});

	it('leaving removes the room once the bridge says done, a cancelled confirm keeps it, a failure is Rocket.Chat\'s error', async () => {
		const { b, src } = fresh();
		const seen = collectChanges(src);
		b.roomResult.leave = { status: 'cancelled' };
		assert.deepEqual(await src.leave(GENERAL), { status: 'cancelled' });
		assert.ok(src.room(GENERAL));
		b.roomResult.leave = Object.assign(new Error('the room could not be left'), { code: 'failed' });
		await assert.rejects(src.leave(GENERAL), { success: false });
		assert.ok(src.room(GENERAL), 'a failed leave leaves the room in the list');
		b.roomResult.leave = undefined;
		assert.deepEqual(await src.leave(GENERAL), { status: 'done', roomId: GENERAL });
		assert.equal(src.room(GENERAL), undefined);
		assert.ok(seen.some((s) => s.includes('removed')), `a removal reaches Rocket.Chat: ${seen.join(',')}`);
	});

	it('the first send in a new chat opens the real room in place of the local one', async () => {
		const real = '!real:example.org';
		const send = bridge.sendText;
		bridge.sendText = async (roomId, text, opts) => {
			const out = await send(roomId, text, opts);
			bridge.rooms().push({ id: real, name: 'Carol', unreadCount: 0, mentionCount: 0, isDirect: true, order: 9 });
			setTimeout(() => bridge.emit({ kind: 'rooms' }), 0);
			return { ...out, roomId: real };
		};
		try {
			await sdk.rest.post('/v1/chat.sendMessage', { message: { _id: 'rc-local', rid: 'local+dm', msg: 'hello' } });
			await new Promise((r) => setTimeout(r, 800));
			assert.deepEqual(opened, [real]);
		} finally {
			bridge.sendText = send;
		}
	});

	it('a renamed room is a later update of its subscription (Rocket.Chat\'s sidebar item re-renders only for a newer _updatedAt)', () => {
		const { b, src } = fresh();
		const before = src.subscriptions().find((s) => s.rid === GENERAL)!;
		b.rooms()[0].name = 'Renamed Chat';
		b.emit({ kind: 'rooms' });
		const after = src.subscriptions().find((s) => s.rid === GENERAL)!;
		assert.equal(after.fname, 'Renamed Chat');
		assert.ok(+after._updatedAt > +before._updatedAt);
		b.emit({ kind: 'rooms' });
		assert.equal(+src.subscriptions().find((s) => s.rid === GENERAL)!._updatedAt, +after._updatedAt, 'an unchanged room keeps its _updatedAt');
	});

	it('a bridge without room actions (version 1) rejects them as unsupported', async () => {
		const b = fixtureBridge();
		Object.assign(b, { createRoom: undefined, leave: undefined });
		const src = new BridgeSource(b);
		await assert.rejects(src.createRoom(), { code: 'unsupported' });
		await assert.rejects(src.leave(GENERAL), { code: 'unsupported' });
	});
});

describe('room item actions: mark unread, favourite, notification level (A10)', () => {
	const fresh = () => {
		const b = fixtureBridge();
		return { b, src: new BridgeSource(b) };
	};
	beforeEach(() => {
		stubLog.length = 0;
		answeredLog.length = 0;
	});

	it('the subscription carries the favourite flag, the notification level and the unread mark from the room', () => {
		const { b, src } = fresh();
		const sub = () => src.subscriptions().find((s) => s.rid === GENERAL)!;
		assert.equal(sub().f, false);
		assert.equal(sub().alert, false, 'a read room that can be marked unread has no alert');
		assert.equal(sub().disableNotifications, false);
		assert.equal(sub().desktopNotifications, 'all');
		Object.assign(b.rooms()[0], { isFavourite: true, canMarkAsUnread: false, showsUnread: true, notificationLevel: 'mentions_only' });
		b.emit({ kind: 'rooms' });
		assert.equal(sub().f, true);
		assert.equal(sub().alert, true, 'a room Element shows unread by a mark or an activity has the unread look');
		assert.equal(sub().unread, 0, 'no count: the mark is not a number');
		assert.equal(sub().desktopNotifications, 'mentions');
		b.rooms()[0].notificationLevel = 'mute';
		b.emit({ kind: 'rooms' });
		assert.equal(sub().disableNotifications, true);
		assert.equal(sub().desktopNotifications, undefined);
	});

	it('Rocket.Chat\'s notification preferences map to one of Element\'s levels, the other fields are ignored', () => {
		assert.equal(notificationLevelOf({ disableNotifications: '1', desktopNotifications: 'all' }), 'mute');
		assert.equal(notificationLevelOf({ disableNotifications: '0', desktopNotifications: 'nothing' }), 'mute');
		assert.equal(notificationLevelOf({ disableNotifications: '0', desktopNotifications: 'mentions', mobilePushNotifications: 'all' }), 'mentions_only');
		assert.equal(notificationLevelOf({ disableNotifications: '0', desktopNotifications: 'all' }), 'all_messages');
		assert.equal(notificationLevelOf({ disableNotifications: '0', desktopNotifications: 'default', emailNotifications: 'nothing' }), 'all_messages');
		assert.equal(notificationLevelOf({ disableNotifications: '0' }), 'all_messages');
	});

	it('POST subscriptions.unread, rooms.favorite and rooms.saveNotification call the bridge once each (a from-message unread is not answered)', async () => {
		bridge.itemCalls.length = 0;
		assert.deepEqual(await sdk.rest.post('/v1/subscriptions.unread', { roomId: GENERAL }), { success: true });
		assert.deepEqual(await sdk.rest.post('/v1/rooms.favorite', { roomId: GENERAL, favorite: true }), { success: true });
		assert.deepEqual(await sdk.rest.post('/v1/rooms.saveNotification', { roomId: GENERAL, notifications: { disableNotifications: '1' } }), { success: true });
		assert.deepEqual(bridge.itemCalls, [['markUnread', GENERAL], ['setFavourite', GENERAL, 'true'], ['setNotificationLevel', GENERAL, 'mute']]);
		await assert.rejects(sdk.rest.post('/v1/subscriptions.unread', { firstUnreadMessage: { _id: 'm' } }), /unread/);
		bridge.itemFail = Object.assign(new Error('the homeserver refused'), { code: 'failed' });
		try {
			await assert.rejects(sdk.rest.post('/v1/rooms.favorite', { roomId: GENERAL, favorite: false }), { success: false, error: 'the homeserver refused' });
		} finally {
			bridge.itemFail = undefined;
		}
	});

	it('the source forwards each action and a refusal is Rocket.Chat\'s error with the room unchanged', async () => {
		const { b, src } = fresh();
		assert.deepEqual(await src.setFavourite(GENERAL, true), { status: 'done', roomId: GENERAL });
		assert.deepEqual(await src.setNotificationLevel(GENERAL, 'mute'), { status: 'done', roomId: GENERAL });
		assert.deepEqual(await src.markUnread(GENERAL), { status: 'done', roomId: GENERAL });
		assert.deepEqual(b.itemCalls, [['setFavourite', GENERAL, 'true'], ['setNotificationLevel', GENERAL, 'mute'], ['markUnread', GENERAL]]);
		b.itemFail = Object.assign(new Error('the homeserver refused'), { code: 'failed' });
		const before = JSON.stringify(src.subscriptions().find((s) => s.rid === RANDOM));
		await assert.rejects(src.setFavourite(RANDOM, true), { success: false });
		assert.equal(JSON.stringify(src.subscriptions().find((s) => s.rid === RANDOM)), before, 'a refused action leaves no star in the subscription');
	});

	it('a room Element does not show unread (a new DM, canMarkAsUnread false) has no unread look', () => {
		const { b, src } = fresh();
		Object.assign(b.rooms()[0], { canMarkAsUnread: false, showsUnread: false });
		b.emit({ kind: 'rooms' });
		assert.equal(src.subscriptions().find((s) => s.rid === GENERAL)!.alert, false);
	});

	it('a save whose level family is unchanged (all vs all messages loud) sends no level change', async () => {
		const { b, src } = fresh();
		b.rooms()[0].notificationLevel = 'all_messages_loud';
		b.emit({ kind: 'rooms' });
		assert.deepEqual(await src.setNotificationLevel(GENERAL, 'all_messages'), { status: 'done', roomId: GENERAL });
		assert.deepEqual(b.itemCalls, [], 'the loud rule is not replaced by a plain all-messages one');
		assert.deepEqual(await src.setNotificationLevel(GENERAL, 'mute'), { status: 'done', roomId: GENERAL });
		assert.deepEqual(b.itemCalls, [['setNotificationLevel', GENERAL, 'mute']]);
	});

	it('a bridge without the actions (version 1) rejects them as unsupported', async () => {
		const b = fixtureBridge();
		Object.assign(b, { markUnread: undefined, setFavourite: undefined, setNotificationLevel: undefined });
		const src = new BridgeSource(b);
		await assert.rejects(src.markUnread(GENERAL), { code: 'unsupported' });
		await assert.rejects(src.setFavourite(GENERAL, true), { code: 'unsupported' });
		await assert.rejects(src.setNotificationLevel(GENERAL, 'mute'), { code: 'unsupported' });
	});
});

describe('categories (M6 B1): the host\'s custom sections as Rocket.Chat\'s sidebar categories', () => {
	const fresh = () => {
		const b = fixtureBridge();
		return { b, src: new BridgeSource(b) };
	};
	const WORK = 'element.io.section.work';
	const HOME = 'element.io.section.home';
	const sections = [{ tag: HOME, name: 'Home', order: 1 }, { tag: WORK, name: 'Work', order: 0 }];

	it('sidebarCategories lists the system groups with the custom ones after Favorites, in Element\'s order, and nothing else', () => {
		const ids = sidebarCategories(sections).map((c) => c._id);
		assert.deepEqual(ids, ['Incoming_Calls', 'Incoming_Livechats', 'Open_Livechats', 'On_Hold_Chats', 'Unread', 'Favorites', WORK, HOME, 'Teams', 'Discussions', 'Channels', 'Direct_Messages', 'Conversations']);
		const custom = sidebarCategories(sections).filter((c) => !('default' in c));
		assert.deepEqual(custom, [{ _id: WORK, name: 'Work', showUnreads: false, keepUnreadsOnTop: false }, { _id: HOME, name: 'Home', showUnreads: false, keepUnreadsOnTop: false }]);
		assert.ok(sidebarCategories([]).every((c) => 'default' in c), 'no section: only the system groups, Rocket.Chat\'s default order');
	});

	it('the user carries the preference only for a host that has sections, and the subscription carries the room\'s category', () => {
		const me = { userId: '@me:x', displayName: 'Me' };
		assert.deepEqual((toUser(me) as { settings: unknown }).settings, { preferences: {} });
		assert.deepEqual((toUser(me, []) as { settings: { preferences: { sidebarCategories: unknown[] } } }).settings.preferences.sidebarCategories.length, 11);
		const room = { id: '!r:x', name: 'R', unreadCount: 0, mentionCount: 0, isDirect: false, order: 0, isFavourite: false, canMarkAsUnread: true, showsUnread: false, notificationLevel: 'all_messages' } as const;
		assert.equal((toSubscription({ ...room, section: WORK }, 'r', me as never, 0) as { category?: string }).category, WORK);
		assert.equal('category' in toSubscription(room, 'r', me as never, 0), false);
	});

	it('the source follows the host: sections in the user\'s preference, the room\'s section in its subscription, a change emitted', () => {
		const { b, src } = fresh();
		const seen: string[] = [];
		src.onChange((c) => seen.push(`${c.kind}:${c.op}`));
		b.sectionList = sections;
		b.rooms()[0].section = WORK;
		b.emit({ kind: 'rooms' });
		const prefs = (src.me.settings as { preferences: { sidebarCategories: Array<{ _id: string }> } }).preferences.sidebarCategories;
		assert.deepEqual(prefs.map((c) => c._id).slice(5, 9), ['Favorites', WORK, HOME, 'Teams']);
		assert.equal((src.subscriptions().find((s) => s.rid === GENERAL) as { category?: string }).category, WORK);
		assert.ok(seen.includes('user:changed') && seen.includes('subscription:changed'), seen.join());
		// A section created with no room in it is a change of the user too.
		seen.length = 0;
		b.sectionList = [...sections, { tag: 'element.io.section.new', name: 'New', order: 2 }];
		b.emit({ kind: 'rooms' });
		assert.deepEqual(seen, ['user:changed']);
	});

	it('POST rooms.setCategory moves each room into the section, or out of its section with null; bad params and a refusal are Rocket.Chat\'s error', async () => {
		bridge.itemCalls.length = 0;
		assert.deepEqual(await sdk.rest.post('/experimental/rooms.setCategory', { roomIds: [GENERAL, RANDOM], category: WORK }), { success: true });
		assert.deepEqual(await sdk.rest.post('/experimental/rooms.setCategory', { roomIds: [GENERAL], category: null }), { success: true });
		assert.deepEqual(bridge.itemCalls, [['setSection', GENERAL, WORK], ['setSection', RANDOM, WORK], ['setSection', GENERAL, 'null']]);
		await assert.rejects(sdk.rest.post('/experimental/rooms.setCategory', { roomIds: [], category: WORK }), /invalid-params/);
		await assert.rejects(sdk.rest.post('/experimental/rooms.setCategory', { roomIds: [GENERAL] }), /invalid-params/);
		bridge.itemFail = Object.assign(new Error('the homeserver refused'), { code: 'failed' });
		try {
			await assert.rejects(sdk.rest.post('/experimental/rooms.setCategory', { roomIds: [GENERAL], category: WORK }), { success: false, error: 'the homeserver refused' });
		} finally {
			bridge.itemFail = undefined;
			bridge.itemCalls.length = 0;
		}
	});

	it('createSection asks the host (the room preselected when given) and answers its outcome; a bridge without it is unsupported', async () => {
		const { b, src } = fresh();
		assert.deepEqual(await src.createSection(GENERAL), { status: 'done', section: 'element.io.section.new', roomId: GENERAL });
		assert.deepEqual(await src.createSection(), { status: 'done', section: 'element.io.section.new' });
		b.createSectionResult = { status: 'cancelled' };
		assert.deepEqual(await src.createSection(), { status: 'cancelled' });
		assert.deepEqual(b.itemCalls, [['createSection', GENERAL], ['createSection', 'undefined'], ['createSection', 'undefined']]);
		b.itemFail = Object.assign(new Error('Element could not write the section'), { code: 'failed' });
		await assert.rejects(src.createSection(GENERAL), { success: false });
		const old = fixtureBridge();
		Object.assign(old, { sections: undefined, setSection: undefined, createSection: undefined });
		const legacy = new BridgeSource(old);
		await assert.rejects(legacy.setSection(GENERAL, null), { code: 'unsupported' });
		await assert.rejects(legacy.createSection(), { code: 'unsupported' });
		assert.deepEqual((legacy.me.settings as { preferences: object }).preferences, {}, 'a host without sections gives the user no categories');
	});

	it('editSection asks the host to rename the section; a returned name is done with the tag, closing at the name step is cancelled, an unknown tag or a refusal is Rocket.Chat\'s error, and a bridge without it is unsupported (M10 W2)', async () => {
		const { b, src } = fresh();
		b.sectionList = sections.map((s) => ({ ...s }));
		b.emit({ kind: 'rooms' });
		assert.deepEqual(await src.editSection(WORK), { status: 'done', section: WORK });
		assert.equal(b.sectionList.find((s) => s.tag === WORK)?.name, 'Renamed', 'the host holds the new name');
		const cat = (src.me.settings as { preferences: { sidebarCategories: Array<{ _id: string; name: string }> } }).preferences.sidebarCategories.find((c) => c._id === WORK);
		assert.equal(cat?.name, 'Renamed', 'the category follows the host');
		b.editSectionResult = { status: 'cancelled' };
		assert.deepEqual(await src.editSection(HOME), { status: 'cancelled' });
		assert.equal(b.sectionList.find((s) => s.tag === HOME)?.name, 'Home', 'a cancel renames nothing');
		await assert.rejects(src.editSection('element.io.section.gone'), { success: false, error: 'the section element.io.section.gone is not listed' });
		b.editSectionResult = Object.assign(new Error('Element could not write the section'), { code: 'network' });
		await assert.rejects(src.editSection(WORK), { success: false, error: 'Element could not write the section' });
		assert.deepEqual(b.itemCalls, [['editSection', WORK], ['editSection', HOME], ['editSection', 'element.io.section.gone'], ['editSection', WORK]]);
		const old = fixtureBridge();
		Object.assign(old, { editSection: undefined });
		await assert.rejects(new BridgeSource(old).editSection(WORK), { code: 'unsupported' });
	});

	it('removeSection asks the host to delete the section; done once the host drops it (its rooms lose the category), declined is cancelled, an unknown tag or a refusal is Rocket.Chat\'s error, and a bridge without it is unsupported (M10 W3)', async () => {
		const { b, src } = fresh();
		b.sectionList = sections.map((s) => ({ ...s }));
		b.rooms()[0].section = WORK;
		b.emit({ kind: 'rooms' });
		const room = b.rooms()[0].id;
		assert.equal((src.subscriptions().find((x) => x.rid === room) as { category?: string }).category, WORK);
		b.removeSectionResult = { status: 'cancelled' };
		assert.deepEqual(await src.removeSection(WORK), { status: 'cancelled' });
		assert.ok(b.sectionList.some((s) => s.tag === WORK), 'a decline deletes nothing');
		b.removeSectionResult = { removed: true };
		assert.deepEqual(await src.removeSection(WORK), { status: 'done', section: WORK });
		assert.deepEqual(b.sectionList.map((s) => s.tag), [HOME], 'the host dropped the section');
		const prefs = (src.me.settings as { preferences: { sidebarCategories: Array<{ _id: string }> } }).preferences.sidebarCategories;
		assert.ok(!prefs.some((c) => c._id === WORK), 'the category is gone');
		assert.equal('category' in (src.subscriptions().find((x) => x.rid === room) as object), false, 'its room falls back to its default group (N6)');
		await assert.rejects(src.removeSection(WORK), { success: false, error: `the section ${WORK} is not listed` });
		b.removeSectionResult = Object.assign(new Error('the section is still listed'), { code: 'network' });
		await assert.rejects(src.removeSection(HOME), { success: false, error: 'the section is still listed' });
		assert.deepEqual(b.itemCalls, [['removeSection', WORK], ['removeSection', WORK], ['removeSection', WORK], ['removeSection', HOME]]);
		const old = fixtureBridge();
		Object.assign(old, { removeSection: undefined });
		await assert.rejects(new BridgeSource(old).removeSection(WORK), { code: 'unsupported' });
	});

	it('moveSection moves the category one place; done once the host shows the new order, an edge or an unknown tag is failed, a refused write is failed and a timeout is network (plain sentences), a cross-realm error keeps its message, and a bridge without it is unsupported (M11 Y3)', async () => {
		const { b, src } = fresh();
		b.sectionList = sections.map((s) => ({ ...s }));
		b.emit({ kind: 'rooms' });
		const customOrder = () => (src.me.settings as { preferences: { sidebarCategories: Array<{ _id: string; default?: boolean }> } }).preferences.sidebarCategories.filter((c) => !c.default).map((c) => c._id);
		assert.deepEqual(customOrder(), [WORK, HOME]);
		assert.equal(src.canMoveSection, true);
		assert.deepEqual(await src.moveSection(WORK, 'down'), { status: 'done', section: WORK });
		assert.deepEqual(b.sectionList.map((s) => s.tag).sort(), [HOME, WORK].sort());
		assert.deepEqual([...b.sectionList].sort((x, y) => x.order - y.order).map((s) => s.tag), [HOME, WORK], 'the host holds the new order');
		assert.deepEqual(customOrder(), [HOME, WORK], 'the category list follows the host');
		await assert.rejects(src.moveSection(HOME, 'up'), { success: false, code: 'failed' });
		await assert.rejects(src.moveSection(WORK, 'down'), { success: false, code: 'failed' });
		await assert.rejects(src.moveSection('element.io.section.gone', 'up'), { success: false, code: 'failed', error: 'the section element.io.section.gone is not listed' });
		assert.deepEqual(customOrder(), [HOME, WORK], 'a refused move changes nothing');
		assert.deepEqual(await src.moveSection(WORK, 'up'), { status: 'done', section: WORK });
		assert.deepEqual(customOrder(), [WORK, HOME], 'moved back');
		b.itemFail = Object.assign(new Error('Element could not write the order'), { code: 'failed' });
		await assert.rejects(src.moveSection(WORK, 'down'), { success: false, code: 'failed', error: 'Element could not write the order' });
		assert.equal(moveFailure(await src.moveSection(WORK, 'down').catch((e: unknown) => e)), CANNOT_MOVE);
		b.itemFail = Object.assign(new Error('the sections did not follow'), { code: 'network' });
		const timeout = await src.moveSection(WORK, 'down').catch((e: unknown) => e);
		assert.equal((timeout as { code: string }).code, 'network');
		assert.equal(moveFailure(timeout), MOVE_NOT_SAVED);
		assert.equal(MOVE_NOT_SAVED, 'The new category order could not be confirmed. Check the list and try again.');
		assert.equal(CANNOT_MOVE, "This category can't be moved");
		assert.equal(moveFailure(undefined), CANNOT_MOVE, 'never the raw error, also for a non-object');
		assert.equal(moveFailure(new Error('raw detail')), CANNOT_MOVE);
		// N8: a host error comes from the other realm, not an `Error` of this one: a plain object keeps its message and code.
		b.itemFail = { message: 'cross-realm refusal', code: 'network' } as unknown as Error;
		await assert.rejects(src.moveSection(WORK, 'down'), { success: false, code: 'network', error: 'cross-realm refusal' });
		b.itemFail = undefined;
		assert.deepEqual(customOrder(), [WORK, HOME], 'no ghost order after the failures');
		assert.deepEqual(b.itemCalls.map((c) => c.join(':')), [
			`moveSection:${WORK}:down`, `moveSection:${HOME}:up`, `moveSection:${WORK}:down`, 'moveSection:element.io.section.gone:up', `moveSection:${WORK}:up`,
			`moveSection:${WORK}:down`, `moveSection:${WORK}:down`, `moveSection:${WORK}:down`, `moveSection:${WORK}:down`,
		]);
		const old = fixtureBridge();
		Object.assign(old, { moveSection: undefined });
		const legacy = new BridgeSource(old);
		assert.equal(legacy.canMoveSection, false);
		await assert.rejects(legacy.moveSection(WORK, 'down'), { code: 'unsupported' });
	});

	it('a user change reaches Rocket.Chat\'s userData stream as a preferences update', () => {
		getSource();
		const got: Array<{ type: string; diff: Record<string, { sidebarCategories: Array<{ _id: string }> }> }> = [];
		const handle = sdk.stream('notify-user', [`${getSource().me._id}/userData`], (d) => got.push(d as never));
		bridge.sectionList = sections;
		bridge.emit({ kind: 'rooms' });
		try {
			assert.equal(got.length, 1);
			assert.equal(got[0].type, 'updated');
			assert.deepEqual(got[0].diff['settings.preferences'].sidebarCategories.map((c) => c._id).slice(5, 8), ['Favorites', WORK, HOME]);
		} finally {
			handle.stop();
			bridge.sectionList = [];
			bridge.emit({ kind: 'rooms' });
		}
	});

	it('a renamed user (the profile dialog saved a new display name) reaches Rocket.Chat\'s userData stream with the name (W4)', () => {
		getSource();
		const got: Array<{ type: string; diff: Record<string, unknown> }> = [];
		const handle = sdk.stream('notify-user', [`${getSource().me._id}/userData`], (d) => got.push(d as never));
		const original = bridge.me;
		bridge.me = () => ({ ...original(), displayName: 'Alice W4 Renamed' });
		bridge.emit({ kind: 'me' });
		try {
			assert.equal(got.length, 1);
			assert.equal(got[0].type, 'updated');
			assert.equal(got[0].diff.name, 'Alice W4 Renamed', 'the user store gets the new name, not only the preferences');
			assert.ok('settings.preferences' in got[0].diff, 'the preferences still ride along');
			assert.equal(getSource().me.name, 'Alice W4 Renamed');
		} finally {
			handle.stop();
			bridge.me = original;
			bridge.emit({ kind: 'me' });
		}
	});
});

describe('upload a file (A8)', () => {
	it('"Upload file" asks the host to upload into the open room (its own picker); cancel, success and a refusal come back as they are', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.deepEqual(await src.upload(GENERAL), { status: 'done', roomId: GENERAL });
		b.uploadResult = { status: 'cancelled' };
		assert.deepEqual(await src.upload(GENERAL), { status: 'cancelled' });
		b.uploadResult = Object.assign(new Error('the upload failed'), { code: 'failed' });
		await assert.rejects(src.upload(GENERAL), { success: false, message: 'the upload failed' });
		// A new chat has no room yet: the host refuses (unsupported) and the refusal reaches the view as an error with its message.
		b.uploadResult = Object.assign(new Error('send a message first'), { code: 'unsupported' });
		await assert.rejects(src.upload(GENERAL), { success: false, code: 'unsupported', message: 'send a message first' });
		assert.deepEqual(b.uploads, [GENERAL, GENERAL, GENERAL, GENERAL]);
	});

	it('rest.upload stays unanswered (drop, paste and recordings reach the host through the swapped upload flow, not this route)', () => {
		assert.throws(() => sdk.rest.upload('/v1/rooms.media/x'), /./);
	});

	it('dropped or pasted files go to the host in one call with all of them (B5); no files keeps the picker path', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const files = [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.png', { type: 'image/png' })];
		assert.deepEqual(await src.upload(GENERAL, files), { status: 'done', roomId: GENERAL });
		await src.upload(GENERAL);
		assert.deepEqual(b.uploads, [GENERAL, GENERAL]);
		assert.deepEqual(b.uploadFiles, [['one.txt', 'two.png'], undefined]);
		b.uploadResult = Object.assign(new Error('the upload failed'), { code: 'failed' });
		await assert.rejects(src.upload(GENERAL, files), { success: false, message: 'the upload failed' });
	});

	it('a bridge without upload (version 1) rejects it as unsupported', async () => {
		const b = fixtureBridge();
		Object.assign(b, { upload: undefined });
		await assert.rejects(new BridgeSource(b).upload(GENERAL), { code: 'unsupported' });
	});
});

describe('log out (A9)', () => {
	it('Meteor.logout and the source ask the host for Element\'s sign-out; a dismissed dialog is cancelled and no error', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.deepEqual(await src.logout(), { status: 'done' });
		b.logoutResult = { status: 'cancelled' };
		assert.deepEqual(await src.logout(), { status: 'cancelled' });
		assert.equal(b.logouts, 2);
	});

	it('Meteor.logout (the call of Rocket.Chat\'s user menu) goes to the host bridge, with the callback', async () => {
		bridge.logouts = 0;
		const calls: unknown[] = [];
		await Meteor.logout((error?: unknown) => calls.push(error));
		assert.equal(bridge.logouts, 1);
		assert.deepEqual(calls, [undefined]);
		bridge.logoutResult = Object.assign(new Error('Element did not sign out in time'), { code: 'failed' });
		try {
			await assert.rejects(Meteor.logout((error?: unknown) => calls.push(error)), { success: false });
			assert.equal(calls.length, 2);
		} finally {
			bridge.logoutResult = undefined;
		}
	});

	it('a bridge without logout (version 1) rejects it as unsupported', async () => {
		const b = fixtureBridge();
		Object.assign(b, { logout: undefined });
		await assert.rejects(new BridgeSource(b).logout(), { code: 'unsupported' });
	});
});

describe('profile and room sort (M10 W4, W6: bridge calls)', () => {
	it('openUserSettings asks the host for Element\'s settings dialog and answers done when it closes', async () => {
		const b = fixtureBridge();
		assert.deepEqual(await new BridgeSource(b).openUserSettings(), { status: 'done' });
		assert.equal(b.userSettingsOpens, 1);
	});

	it('a failed openUserSettings keeps the host\'s code; a bridge without it is unsupported', async () => {
		const b = fixtureBridge();
		b.userSettingsResult = Object.assign(new Error('Element could not open its settings'), { code: 'failed' });
		await assert.rejects(new BridgeSource(b).openUserSettings(), { code: 'failed', message: 'Element could not open its settings' });
		const old = fixtureBridge();
		Object.assign(old, { openUserSettings: undefined });
		await assert.rejects(new BridgeSource(old).openUserSettings(), { code: 'unsupported' });
		assert.equal(old.userSettingsOpens, 0);
	});

	it('setRoomSort hands recent and alphabetical to the host and answers done', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.deepEqual(await src.setRoomSort('alphabetical'), { status: 'done' });
		assert.deepEqual(await src.setRoomSort('recent'), { status: 'done' });
		assert.deepEqual(b.sortCalls, ['alphabetical', 'recent']);
	});

	it('setRoomSort("unread-first") is unsupported (the kit offers no such radio) and never reaches the host', async () => {
		const b = fixtureBridge();
		await assert.rejects(new BridgeSource(b).setRoomSort('unread-first' as 'recent'), { code: 'unsupported' });
		assert.deepEqual(b.sortCalls, []);
	});

	it('a room list store that is not ready is failed; a bridge without setRoomSort is unsupported', async () => {
		const b = fixtureBridge();
		b.sortResult = Object.assign(new Error('the room list is not ready'), { code: 'failed' });
		await assert.rejects(new BridgeSource(b).setRoomSort('alphabetical'), { code: 'failed', message: 'the room list is not ready' });
		const old = fixtureBridge();
		Object.assign(old, { setRoomSort: undefined });
		await assert.rejects(new BridgeSource(old).setRoomSort('recent'), { code: 'unsupported' });
	});
});

describe('room sort (M10 W6: the Display menu radios over Element\'s sort)', () => {
	const prefs = (u: unknown) => (u as { settings: { preferences: Record<string, unknown> } }).settings.preferences;
	const me = { userId: '@alice:example.org', displayName: 'Alice' };
	beforeEach(() => {
		stubLog.length = 0;
		answeredLog.length = 0;
		bridge.sortCalls.length = 0;
		bridge.sortResult = undefined;
		bridge.roomSort = undefined;
		bridge.emit({ kind: 'me' });
	});

	it('the user carries Element\'s sort as sidebarSortby: recent Activity, alphabetical Name, unread-first neither radio, unreported nothing', () => {
		assert.equal(prefs(toUser({ ...me, roomSort: 'recent' })).sidebarSortby, 'activity');
		assert.equal(prefs(toUser({ ...me, roomSort: 'alphabetical' })).sidebarSortby, 'alphabetical');
		assert.equal(prefs(toUser({ ...me, roomSort: 'unread-first' })).sidebarSortby, 'unread-first', 'neither the activity nor the name radio matches it');
		assert.equal('sidebarSortby' in prefs(toUser(me)), false);
		assert.deepEqual(Object.keys(prefs(toUser({ ...me, roomSort: 'recent' }, []))).sort(), ['sidebarCategories', 'sidebarSortby']);
	});

	it('a sort change in Element reaches the user document the Display menu reads, as a user change', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'user' && seen.push(String(prefs(c.doc).sidebarSortby)));
		assert.equal('sidebarSortby' in prefs(src.me), false);
		b.roomSort = 'alphabetical';
		b.emit({ kind: 'me' });
		assert.equal(prefs(src.me).sidebarSortby, 'alphabetical');
		b.roomSort = 'unread-first';
		b.emit({ kind: 'me' });
		assert.deepEqual(seen, ['alphabetical', 'unread-first']);
	});

	it('POST users.setPreferences { sidebarSortby } sets Element\'s sort once per radio; the user document follows from the host', async () => {
		assert.deepEqual(await sdk.rest.post('/v1/users.setPreferences', { data: { sidebarSortby: 'alphabetical' } }), { success: true });
		assert.deepEqual(await sdk.rest.post('/v1/users.setPreferences', { data: { sidebarSortby: 'activity' } }), { success: true });
		assert.deepEqual(bridge.sortCalls, ['alphabetical', 'recent']);
		assert.equal(answeredLog.filter((a) => a.includes('users.setPreferences')).length, 2);
	});

	it('any other preference, a mixed body, an unknown value or no data stays N/A, logged, and never reaches the host', async () => {
		for (const data of [{ theme: 'dark' }, { sidebarSortby: 'unread-first' }, { sidebarSortby: 'activity', sidebarViewMode: 'condensed' }, {}, null]) {
			await assert.rejects(sdk.rest.post('/v1/users.setPreferences', { data }), /N\/A: rest\.post/);
		}
		await assert.rejects(sdk.rest.post('/v1/users.setPreferences', {}), /N\/A: rest\.post/);
		assert.deepEqual(bridge.sortCalls, []);
		assert.equal(stubLog.filter((e) => e.name === '/v1/users.setPreferences').length, 6);
	});

	it('a refused sort is Rocket.Chat\'s error and leaves the sort and the user document as they were', async () => {
		bridge.sortResult = Object.assign(new Error('the room list is not ready'), { code: 'failed' });
		await assert.rejects(sdk.rest.post('/v1/users.setPreferences', { data: { sidebarSortby: 'alphabetical' } }), { success: false, error: 'the room list is not ready', errorType: 'error-failed' });
		assert.equal(bridge.roomSort, undefined);
		assert.equal('sidebarSortby' in prefs(getSource().me), false);
	});
});

describe('call card (lane CALL, step 2: read side)', () => {
	const view = (over: Record<string, unknown> = {}) => ({
		id: '$call', roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', ts: 5000, body: '', kind: 'other' as const,
		call: { callId: '$call', state: 'ongoing' as const, callType: 'video' as const, isDm: false, startedTs: 5000, participants: [{ userId: '@bob:example.org', name: 'Bob', avatarUrl: 'https://hs/bob.png' }], participantCount: 1 },
		...over,
	});

	it('the call root is Rocket.Chat\'s videoconf message: one video_conf block of that call, no text of its own', () => {
		const doc = toMessage(view()) as unknown as { t: string; msg: string; groupable: boolean; blocks: Record<string, unknown>[]; _id: string };
		assert.equal(doc.t, 'videoconf');
		assert.equal(doc.groupable, false);
		assert.deepEqual(doc.blocks, [{ type: 'video_conf', blockId: '$call', callId: '$call', appId: 'videoconf-core' }]);
		assert.equal(doc._id, '$call');
		assert.equal('t' in (toMessage(bridge.timeline(GENERAL)[0]) as object), false, 'an ordinary message has no t');
	});

	it('M7 E4 F2: a call card carries kitCanReport false (no Report item); an ordinary message carries true', () => {
		assert.equal((toMessage(view()) as unknown as { kitCanReport: boolean }).kitCanReport, false);
		assert.equal((toMessage(bridge.timeline(GENERAL)[0]) as unknown as { kitCanReport: boolean }).kitCanReport, true);
	});

	it('info answers the call as Rocket.Chat\'s VideoConference: ongoing = STARTED, the participants as joined users, no endedAt', async () => {
		const b = fixtureBridge();
		b.timeline(GENERAL).push(view() as never);
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const info = src.videoConference('$call') as Record<string, any>;
		assert.equal(info.status, 1);
		assert.equal(info.type, 'videoconference');
		assert.equal(info.rid, GENERAL);
		assert.equal(info.providerName, 'aqua-meet');
		assert.equal('endedAt' in info, false);
		assert.deepEqual(info.createdBy, { _id: '@bob:example.org', username: '@bob:example.org', name: 'Bob' });
		assert.deepEqual(info.users.map((u: any) => [u.username, u.name, u.joined]), [['@bob:example.org', 'Bob', true]]);
		assert.equal(src.avatar('@bob:example.org'), 'https://hs/bob.png', 'the face pile avatar is the participant\'s, though Bob wrote no message');
		assert.equal(src.videoConference('$unknown'), undefined);
	});

	it('Rocket.Chat counts as many joined users as Element\'s participantCount: the named face pile first, then count-only entries it never draws or names', () => {
		const names = ['Bob', 'Carol', 'Dan'];
		const call = { ...view().call, participantCount: 8, participants: names.map((n) => ({ userId: `@${n.toLowerCase()}:example.org`, name: n })) };
		const b = fixtureBridge();
		b.timeline(GENERAL).push(view({ call }) as never);
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const users = (src.videoConference('$call') as any).users as Array<{ _id: string; username: string; name: string; joined: boolean }>;
		// RC's own filter (VideoConferenceBlock): a username and not left out of the joined flag.
		const joined = users.filter((u) => !!u.username && u.joined !== false);
		assert.equal(joined.length, 8);
		// RC draws and names joinedUsers.slice(0, 3): only the real participants, in Element's order.
		assert.deepEqual(joined.slice(0, 3).map((u) => u.name), names);
		for (const pad of joined.slice(3)) {
			assert.equal(pad.name, '');
			assert.equal(pad.username, '\u200b');
			assert.ok(!/@|:/.test(pad.username), 'no identity in a count-only entry');
		}
		assert.equal(new Set(users.map((u) => u._id)).size, 8, 'distinct ids');
		// With 5 participants the card is: three avatars (Bob, Carol, Dan), "+ 2 joined", tooltip "Bob, Carol, Dan and 2 more joined".
		const five = toVideoConference(view({ call: { ...call, participantCount: 5 } }) as never, 0) as any;
		assert.equal(five.users.length, 5);
		// No padding when the face pile already holds everyone, for a DM tile (no count), or for an ended call.
		assert.equal((toVideoConference(view({ call: { ...call, participantCount: 3 } }) as never, 0) as any).users.length, 3);
		assert.equal((toVideoConference(view({ call: { ...call, participantCount: undefined } }) as never, 0) as any).users.length, 3);
		assert.equal((toVideoConference(view({ call: { ...call, state: 'ended', participants: [] } }) as never, 0) as any).users.length, 0);
	});

	it('the ended state has endedAt (the card reads `endedAt in data`), DECLINED for a declined DM, and the path answers it over REST', async () => {
		const ended = view({ call: { callId: '$call', state: 'ended', callType: 'voice', isDm: true, startedTs: 5000, participants: [], declined: true } });
		const b = fixtureBridge();
		b.timeline(GENERAL).push(ended as never);
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const info = src.videoConference('$call') as Record<string, any>;
		assert.equal(info.status, 4);
		assert.ok(info.endedAt instanceof Date);
		assert.deepEqual(info.users, []);
		// `sdk` answers from the window's bridge: hand it the call for this check only.
		const shared = bridge.timeline(GENERAL);
		shared.push(ended as never);
		try {
			getSource().history(GENERAL);
			const rest = await sdk.rest.get('/v1/video-conference.info', { callId: '$call' });
			assert.equal(typeof (rest as any).endedAt, 'string', 'REST delivers ISO strings');
			await assert.rejects(sdk.rest.get('/v1/video-conference.info', { callId: '$none' }), { success: false });
		} finally {
			shared.splice(shared.indexOf(ended as never), 1);
		}
	});

	it('a change of the call (a participant joins, the call ends) is the room\'s videoconf stream naming the call; a ticking duration is none', () => {
		const b = fixtureBridge();
		const timeline = b.timeline(GENERAL);
		// The real bridge hands a fresh object on every snapshot.
		const show = (call: Record<string, unknown>) => {
			timeline.splice(0, timeline.length, ...timeline.filter((m) => m.id !== '$call'), view({ call }) as never);
			b.emit({ kind: 'timeline', roomId: GENERAL });
		};
		const first = view().call as Record<string, any>;
		show(first);
		const src = new BridgeSource(b);
		src.history(GENERAL);
		const changes: Array<{ kind: string; doc: unknown }> = [];
		src.onChange((c) => changes.push(c as never));
		show({ ...first, durationSeconds: 7 });
		assert.equal(changes.filter((c) => c.kind === 'videoconf').length, 0);
		show({ ...first, participants: [...first.participants, { userId: '@carol:example.org', name: 'Carol' }], participantCount: 2 });
		show({ ...first, state: 'ended', participants: [] });
		assert.deepEqual(changes.filter((c) => c.kind === 'videoconf').map((c) => c.doc), [{ rid: GENERAL, callId: '$call' }, { rid: GENERAL, callId: '$call' }]);
		assert.equal((src.videoConference('$call') as any).status, 3);
	});

	it('the sdk stream seam delivers it as notify-room `<rid>/videoconf` with the call id (the key useVideoConfDataStream listens on)', () => {
		const b = fixtureBridge();
		const row = view() as any;
		b.timeline(GENERAL).push(row);
		getSource().history(GENERAL);
		const got: unknown[] = [];
		const handle = sdk.stream('notify-room', [`${GENERAL}/videoconf`, false], (id: unknown) => got.push(id));
		// The shared window bridge feeds getSource(); drive its source directly with a changed call.
		const src = getSource();
		(src as any).emit({ kind: 'videoconf', op: 'changed', doc: { rid: GENERAL, callId: '$call' } });
		handle.stop();
		assert.deepEqual(got, ['$call']);
	});
});

describe('calls: settings, start, join (lane CALL, step 3: write side)', () => {
	const MEET = 'https://meet.example.org';
	const room = '!Team:example.org';
	const ongoing = (over: Record<string, unknown> = {}) => ({
		id: '$running', roomId: room, senderId: '@bob:example.org', senderName: 'Bob', ts: 5000, body: '', kind: 'other' as const,
		call: { callId: '$running', state: 'ongoing' as const, callType: 'video' as const, isDm: false, startedTs: 5000, participants: [], participantCount: 1 },
		...over,
	});
	const settingsOf = async () => Object.fromEntries(((await sdk.call('public-settings/get')) as { _id: string; value: unknown }[]).map((s) => [s._id, s.value]));
	const permissionsOf = async () => ((await sdk.call('permissions/get')) as { _id: string }[]).map((p) => p._id);
	const setMeet = (url: string | undefined) => {
		(bridge as unknown as { meet: string | undefined }).meet = url;
	};

	beforeEach(() => {
		stubLog.length = 0;
		answeredLog.length = 0;
	});
	afterEach(() => setMeet(undefined));

	it('with a Meet address: provider aqua-meet, the four room-type switches on, the call-management permission', async () => {
		setMeet(MEET);
		const s = await settingsOf();
		assert.equal(s.VideoConf_Default_Provider, 'aqua-meet');
		for (const k of ['VideoConf_Enable_DMs', 'VideoConf_Enable_Channels', 'VideoConf_Enable_Groups', 'VideoConf_Enable_Teams']) assert.equal(s[k], true, k);
		assert.ok((await permissionsOf()).includes('call-management'));
	});

	it('without it (C5): no provider, the switches explicitly off (Rocket.Chat defaults them on), no permission, and the call endpoints are refused', async () => {
		const s = await settingsOf();
		assert.equal(s.VideoConf_Default_Provider, '');
		for (const k of ['VideoConf_Enable_DMs', 'VideoConf_Enable_Channels', 'VideoConf_Enable_Groups', 'VideoConf_Enable_Teams']) assert.equal(s[k], false, k);
		assert.ok(!(await permissionsOf()).includes('call-management'));
		await assert.rejects(sdk.rest.get('/v1/video-conference.capabilities'), { success: false });
		await assert.rejects(sdk.rest.post('/v1/video-conference.start', { roomId: GENERAL }), { success: false });
		await assert.rejects(sdk.rest.post('/v1/video-conference.join', { callId: '$x' }), { success: false });
	});

	it('capabilities: provider aqua-meet, and NO mic or cam (the call app ignores the popup choice, so Rocket.Chat shows no toggles)', async () => {
		setMeet(MEET);
		const out = (await sdk.rest.get('/v1/video-conference.capabilities')) as Record<string, any>;
		assert.equal(out.providerName, 'aqua-meet');
		assert.ok(!out.capabilities?.mic && !out.capabilities?.cam);
		assert.deepEqual(out.capabilities ?? {}, {});
	});

	it('start gives a fresh conference bound to the room (type videoconference, no ringing); join gives the Meet room link with the room id URL-encoded', async () => {
		setMeet(MEET);
		const started = (await sdk.rest.post('/v1/video-conference.start', { roomId: room, allowRinging: true })) as { data: Record<string, any> };
		assert.equal(started.data.type, 'videoconference');
		assert.equal(started.data.rid, room);
		assert.equal(started.data.providerName, 'aqua-meet');
		assert.ok(started.data.callId);
		const joined = (await sdk.rest.post('/v1/video-conference.join', { callId: started.data.callId, state: { mic: true } })) as Record<string, any>;
		assert.equal(joined.url, `${MEET}/#/room/${encodeURIComponent(room)}`);
		assert.equal(joined.url, 'https://meet.example.org/#/room/!Team%3Aexample.org');
		assert.equal(joined.providerName, 'aqua-meet');
		assert.equal(decodeURIComponent(new URL(joined.url).hash.slice('#/room/'.length)), room);
		await assert.rejects(sdk.rest.post('/v1/video-conference.start', {}), { success: false });
		await assert.rejects(sdk.rest.post('/v1/video-conference.join', { callId: 'unknown' }), { success: false });
	});

	it('start while a call runs in the room returns that call (no second call); join of it is the same link; a call of another room is not reused', async () => {
		setMeet(MEET);
		const shared = bridge.timeline(GENERAL);
		const call = ongoing({ roomId: GENERAL });
		shared.push(call as never);
		try {
			getSource().history(GENERAL);
			const again = (await sdk.rest.post('/v1/video-conference.start', { roomId: GENERAL })) as { data: Record<string, any> };
			assert.equal(again.data.callId, '$running');
			const joined = (await sdk.rest.post('/v1/video-conference.join', { callId: '$running' })) as Record<string, any>;
			assert.equal(joined.url, `${MEET}/#/room/${encodeURIComponent(GENERAL)}`);
			const other = (await sdk.rest.post('/v1/video-conference.start', { roomId: RANDOM })) as { data: Record<string, any> };
			assert.notEqual(other.data.callId, '$running');
		} finally {
			shared.splice(shared.indexOf(call as never), 1);
		}
	});

	it('an ended call is not joined; cancel, leave and heartbeat are no-op successes; decline, ring, list and rename stay rejected and logged', async () => {
		setMeet(MEET);
		const shared = bridge.timeline(GENERAL);
		const call = ongoing({ id: '$over', roomId: GENERAL, call: { callId: '$over', state: 'ended', callType: 'video', isDm: false, startedTs: 5000, participants: [] } });
		shared.push(call as never);
		try {
			getSource().history(GENERAL);
			await assert.rejects(sdk.rest.post('/v1/video-conference.join', { callId: '$over' }), { success: false });
		} finally {
			shared.splice(shared.indexOf(call as never), 1);
		}
		for (const name of ['cancel', 'leave', 'heartbeat']) assert.deepEqual(await sdk.rest.post(`/v1/video-conference.${name}`, { callId: '$x' }), { success: true });
		for (const name of ['decline', 'ring', 'rename']) await assert.rejects(sdk.rest.post(`/v1/video-conference.${name}`, { callId: '$x' }), /N\/A/);
		await assert.rejects(sdk.rest.get('/v1/video-conference.list'), /N\/A/);
		assert.deepEqual(stubLog.map((c) => c.name).sort(), ['/v1/video-conference.decline', '/v1/video-conference.list', '/v1/video-conference.rename', '/v1/video-conference.ring']);
	});
});

describe('encryption event line (M12 Z4, interim D41)', () => {
	const view = (encryption: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
		id: '$enc:' + GENERAL, roomId: GENERAL, senderId: '@alice:example.org', senderName: 'Alice', ts: 5000, body: '', kind: 'other' as const,
		...(encryption ? { encryption } : {}),
		...over,
	});
	type Line = { t?: string; msg: string; groupable?: boolean; kitCanReport: boolean };
	const listed = (src: InstanceType<typeof BridgeSource>, id = '$enc:' + GENERAL) => (src.history(GENERAL) as unknown as (Line & { _id: string })[]).find((m) => m._id === id);

	for (const state of ['enabled', 'enabled_dm', 'enabled_local']) {
		it(`state ${state} is Rocket.Chat's "End-to-end encryption enabled" system line: room_e2e_enabled, empty text, not grouped, no Report`, () => {
			const doc = toMessage(view({ state, ...(state === 'enabled_dm' ? { userName: 'Bob' } : {}) }) as never) as unknown as Line & { _id: string };
			assert.equal(doc.t, 'room_e2e_enabled');
			assert.equal(doc.msg, '');
			assert.equal(doc.groupable, false);
			assert.equal(doc.kitCanReport, false);
			assert.equal(doc._id, '$enc:' + GENERAL);
		});
	}

	it('an ordinary message and a message with no encryption field have no system type', () => {
		assert.equal('t' in (toMessage(bridge.timeline(GENERAL)[0]) as object), false);
		assert.equal('t' in (toMessage(view(undefined) as never) as object), false);
		assert.equal(encryptionLine({ state: 'enabled' })?.t, 'room_e2e_enabled');
	});

	for (const state of ['changed', 'disable_attempt', 'unsupported']) {
		it(`state ${state} has no Rocket.Chat line (room_e2e_disabled would claim encryption was turned off): the entry is dropped from the history`, () => {
			assert.equal(encryptionLine({ state: state as never }), undefined);
			const b = fixtureBridge();
			b.encryption(GENERAL, state as never);
			const src = new BridgeSource(b);
			assert.equal(listed(src), undefined, 'no row');
			assert.ok(src.history(GENERAL).every((m) => !(m as unknown as { t?: string }).t), 'and no system row of another type');
			assert.equal(src.history(GENERAL).length, 2, 'the two ordinary messages stay');
		});
	}

	it('the line shows once the room has it, comes from the timeline event, and is removed when the state flips to unsupported (enabled again: shown again)', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.equal(listed(src), undefined, 'no encryption entry: no line');
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'message' && seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		b.encryption(GENERAL, 'enabled');
		assert.equal(listed(src)?.t, 'room_e2e_enabled');
		assert.ok(seen.includes('changed:$enc:' + GENERAL), 'the line was announced');
		b.encryption(GENERAL, 'unsupported');
		assert.ok(seen.includes('removed:$enc:' + GENERAL), 'the earlier line was removed');
		assert.equal(listed(src), undefined);
		b.encryption(GENERAL, 'enabled_dm', 'Bob');
		assert.equal(listed(src)?.t, 'room_e2e_enabled', 'enabled again, shown again');
	});

	it('the pre-send local chat entry (an id starting with "~") maps to the system line like any other: the kit has no filter on "~" ids', () => {
		const localId = '~!local+bob:txn';
		const b = fixtureBridge();
		b.timeline(GENERAL).push(view({ state: 'enabled_local' }, { id: localId }) as never);
		const src = new BridgeSource(b);
		const line = listed(src, localId);
		assert.equal(line?.t, 'room_e2e_enabled');
		assert.equal(line?.msg, '');
		assert.equal(line?.kitCanReport, false);
		const doc = toMessage(view({ state: 'enabled_local' }, { id: localId }) as never) as unknown as { _id: string; t: string };
		assert.equal(doc._id, localId);
		assert.equal(doc.t, 'room_e2e_enabled');
	});
});

describe('mentions (M7 E2, interim D31)', () => {
	const type = JSON.stringify({ users: true, mentions: true });
	const spot = (query: string, rid = GENERAL) => sdk.rest.get('/v1/spotlight', { query, rid, type, usernames: '' }) as Promise<{ users: Record<string, unknown>[]; rooms: unknown[]; success: boolean }>;
	const post = (rid: string, msg: string, _id = 'rc-m1') => sdk.rest.post('/v1/chat.sendMessage', { message: { _id, rid, msg } });
	const BOB = '@bob:example.org';
	const MID = '$m1';
	const sentMentions = () => (bridge.sent.at(-1) as { mentions?: string[] }).mentions;

	it('the @ popup is answered from the bridge: the members Element offers, id and username = the MXID', async () => {
		const found = await spot('bo');
		assert.deepEqual(found, { users: [{ _id: BOB, username: BOB, name: 'Bob', status: 'online' }], rooms: [], success: true });
		assert.deepEqual((bridge as unknown as { mentionQueries: string[][] }).mentionQueries.at(-1), [GENERAL, 'bo']);
	});

	it('an unknown room is the error shape the other bridge calls use', async () => {
		await assert.rejects(spot('bo', '!nope:example.org'), (e: Error & { success: boolean; errorType: string }) => e.success === false && e.errorType === 'error-unknown_room');
	});

	it('a send carries the picked members whose MXID is still a token of the text; @all/@here stay text', async () => {
		await spot('bo');
		await post(GENERAL, `${BOB} hi @all and @here`);
		assert.deepEqual(sentMentions(), [BOB]);
		await spot('bo');
		await post(GENERAL, `see ${BOB}, ${BOB}. and (${BOB})`, 'rc-m2');
		assert.deepEqual(sentMentions(), [BOB]);
	});

	it('no mention when the token was edited away or is part of another word; nothing offered, nothing sent', async () => {
		await spot('bo');
		for (const text of ['hello bob', `x${BOB}`, `${BOB}x`, `${BOB}:1`, `${BOB}.org`, `@all @here`]) {
			await post(GENERAL, text, 'rc-m3');
			assert.equal(sentMentions(), undefined, text);
		}
		await post(RANDOM, BOB, 'rc-m4');
		assert.equal(sentMentions(), undefined, 'candidates are per room');
	});

	it('an edit carries the mention the same way', async () => {
		await spot('bo');
		getSource().history(GENERAL);
		await sdk.rest.post('/v1/chat.update', { msgId: MID, roomId: GENERAL, text: `${BOB} edited` });
		assert.deepEqual(bridge.editOpts.at(-1), { markdown: true, mentions: [BOB] });
		await sdk.rest.post('/v1/chat.update', { msgId: MID, roomId: GENERAL, text: 'edited, no mention' });
		assert.deepEqual(bridge.editOpts.at(-1), { markdown: true });
	});

	// A received pill is not rewritten for the row (M7 E2 cut, grok e2t delta5 LIMIT): the name shows as plain text.
	const pillMsg = (body: string, formattedBody: string) => toMessage({ ...bridge.timeline(GENERAL)[1], body, formattedBody });

	describe('offers and edits', () => {
		const pilled = () => {
			const b = fixtureBridge();
			const m = b.timeline(GENERAL)[0];
			Object.assign(m, { body: `${'Bob'} look`, formattedBody: `<a href="https://matrix.to/#/${BOB}">Bob</a> look` });
			const src = new BridgeSource(b);
			src.history(GENERAL);
			return { b, src };
		};

		it('F2: an edit without the popup keeps the message\'s own mention (its pill) while its MXID is still a token', async () => {
			const { b, src } = pilled();
			await src.editText('$m1', `${BOB} look again`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB] });
			await src.editText('$m1', 'no mention now');
			assert.deepEqual(b.editOpts.at(-1), { markdown: true });
		});

		it('F2: the offered set follows a local chat to its real room id', async () => {
			const { src } = pilled();
			await src.mentionCandidates(GENERAL, 'bo');
			src.moveOffered(GENERAL, '!real:example.org');
			assert.deepEqual(src.mentionsIn('!real:example.org', `${BOB} hi`), [BOB]);
			assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} hi`), []);
		});

		it('F3: offers are scoped to the draft: after a send they are gone, a hand-typed MXID later is no mention', async () => {
			await sdk.rest.get('/v1/spotlight', { query: 'bo', rid: GENERAL, type, usernames: '' });
			await post(GENERAL, 'no mention in this one', 'rc-f3a');
			assert.equal(sentMentions(), undefined);
			await post(GENERAL, `typed ${BOB}`, 'rc-f3b');
			assert.equal(sentMentions(), undefined);
		});

		it('F3: offers are gone after an edit too, the edited message\'s own mentions still count', async () => {
			const { b, src } = pilled();
			await src.mentionCandidates(GENERAL, 'carol');
			await src.editText('$m1', `${BOB} @carol:example.org`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB, '@carol:example.org'] });
			// The fixture's edit keeps the old pill markup (no pill matches the new body): only the offers could still name Carol.
			await src.editText('$m1', `${BOB} @carol:example.org again`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB] });
		});

		it('an edit keeps the pill mention while its name is still in the new text, sent as its id token (the host pills only tokens)', async () => {
			const { b, src } = pilled();
			const sent = () => b.edits.at(-1)?.[2];
			await src.editText('$m1', 'hi Bob');
			assert.equal(sent(), `hi ${BOB}`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB] });
			await src.editText('$m1', 'Bob look again');
			assert.equal(sent(), `${BOB} look again`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB] });
			await src.editText('$m1', 'Bob and Bob');
			assert.equal(sent(), `${BOB} and Bob`);
			await src.editText('$m1', 'Bobby look');
			assert.equal(sent(), 'Bobby look');
			assert.deepEqual(b.editOpts.at(-1), { markdown: true });
			await src.editText('$m1', 'look again');
			assert.equal(sent(), 'look again');
			assert.deepEqual(b.editOpts.at(-1), { markdown: true });
		});

		it('two pills are both sent as their ids, in text order; an id already a token is left alone', async () => {
			const ALI = '@alice:example.org';
			const b = fixtureBridge();
			Object.assign(b.timeline(GENERAL)[0], { body: 'Bob Alice', formattedBody: `<a href="https://matrix.to/#/${BOB}">Bob</a> <a href="https://matrix.to/#/${ALI}">Alice</a>` });
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.editText('$m1', 'Alice meets Bob.');
			assert.equal(b.edits.at(-1)?.[2], `${ALI} meets ${BOB}.`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [ALI, BOB] });
			await src.editText('$m1', `${BOB} and Alice`);
			assert.equal(b.edits.at(-1)?.[2], `${BOB} and ${ALI}`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB, ALI] });
		});

		it('overlapping name ranges: the earlier one in the text wins, the other is not carried', async () => {
			const ALI = '@alice:example.org';
			const b = fixtureBridge();
			Object.assign(b.timeline(GENERAL)[0], { body: 'Ann Lee Lee', formattedBody: `<a href="https://matrix.to/#/${BOB}">Ann Lee</a> <a href="https://matrix.to/#/${ALI}">Lee</a>` });
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.editText('$m1', 'hi Ann Lee');
			assert.equal(b.edits.at(-1)?.[2], `hi ${BOB}`);
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [BOB] });
		});

		it('only @-user links are carried: a room or event link is not a mention', async () => {
			const b = fixtureBridge();
			Object.assign(b.timeline(GENERAL)[0], {
				body: 'Room Event Bob',
				formattedBody: '<a href="https://matrix.to/#/!room:example.org">Room</a> <a href="https://matrix.to/#/%23ali:example.org">Event</a> <a href="https://matrix.to/#/!room:example.org/$ev:example.org">Event</a> <a href="https://matrix.to/#/@bad:">Bob</a>',
			});
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.editText('$m1', 'Room Event Bob !room:example.org');
			assert.deepEqual(b.editOpts.at(-1), { markdown: true });
		});

		it('a hostile href id is carried only as a list entry, never in the text', async () => {
			const evil = '@a.__x__.b:evil.com';
			const b = fixtureBridge();
			Object.assign(b.timeline(GENERAL)[0], { body: 'Hi Bob', formattedBody: `Hi <a href="https://matrix.to/#/${encodeURIComponent(evil)}">Bob</a>` });
			const src = new BridgeSource(b);
			src.history(GENERAL);
			await src.editText('$m1', 'Hi Bob again');
			assert.deepEqual(b.editOpts.at(-1), { markdown: true, mentions: [evil] });
			assert.equal(b.edits.at(-1)?.[2], `Hi ${evil} again`);
			for (const bad of ['@x:y](https://evil.example)', '@bob:[::1]', '@__x__:evil.com']) {
				Object.assign(b.timeline(GENERAL)[0], { formattedBody: `Hi <a href="https://matrix.to/#/${encodeURIComponent(bad)}">Bob</a>` });
				await src.editText('$m1', 'Hi Bob again');
				assert.deepEqual(b.editOpts.at(-1), { markdown: true }, bad);
			}
		});
	});

	// ---- kit fix round 2 (grok e2t delta F1-F4) ----
	describe('kfix2 offers', () => {
		const withPick = async (mode: 'resolve-first' | 'reject-after-echo' = 'resolve-first') => {
			const b = fixtureBridge();
			b.sendMode = mode;
			const src = new BridgeSource(b);
			src.history(GENERAL);
			return { b, src };
		};
		const gate = (b: ReturnType<typeof fixtureBridge>, roomId?: string) => {
			const orig = b.sendText as NonNullable<typeof b.sendText>;
			let open!: () => void;
			const wait = new Promise<void>((r) => (open = r));
			(b as { sendText: unknown }).sendText = async (...a: Parameters<typeof orig>) => {
				await wait;
				const out = await orig(...a);
				return roomId ? { ...out, roomId } : out;
			};
			return open;
		};

		it('kfix2 F3: a send that is done through the echo-held path clears the draft\'s offers', async () => {
			const { b, src } = await withPick('reject-after-echo');
			await src.mentionCandidates(GENERAL, 'bo');
			const out = await src.sendText(GENERAL, 'plain', 'rc-e1');
			assert.equal(out.status, 'done');
			b.sendMode = 'resolve-first';
			await src.sendText(GENERAL, `${BOB} hi`, 'rc-e2');
			assert.equal((b.sent.at(-1) as { mentions?: string[] }).mentions, undefined);
		});

		it('kfix2 F4: a pick made while a send is in flight survives that send', async () => {
			const { b, src } = await withPick();
			const open = gate(b);
			await src.mentionCandidates(GENERAL, 'bo');
			const sending = src.sendText(GENERAL, `${BOB} first`, 'rc-f1');
			await src.mentionCandidates(GENERAL, 'carol');
			open();
			await sending;
			assert.deepEqual((b.sent.at(-1) as { mentions?: string[] }).mentions, [BOB]);
			assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} @carol:example.org`), ['@carol:example.org']);
		});

		it('kfix2 F4: a new chat\'s mid-flight pick survives the room id flip, the sent draft\'s pick does not', async () => {
			const { b, src } = await withPick();
			const REAL = '!real:example.org';
			const open = gate(b, REAL);
			await src.mentionCandidates(GENERAL, 'bo');
			const sending = src.sendText(GENERAL, `${BOB} first`, 'rc-g1');
			await src.mentionCandidates(GENERAL, 'carol');
			open();
			await sending;
			src.moveOffered(GENERAL, REAL);
			assert.deepEqual(src.mentionsIn(REAL, `${BOB} @carol:example.org`), ['@carol:example.org']);
			assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} @carol:example.org`), []);
		});

		it('kfix2 F4: a pick made while an edit is in flight survives that edit', async () => {
			const { b, src } = await withPick();
			await src.mentionCandidates(GENERAL, 'bo');
			const orig = b.editText as NonNullable<typeof b.editText>;
			let open!: () => void;
			const wait = new Promise<void>((r) => (open = r));
			(b as { editText: unknown }).editText = async (...a: Parameters<typeof orig>) => {
				await wait;
				return orig(...a);
			};
			const editing = src.editText('$m1', `${BOB} edited`);
			await src.mentionCandidates(GENERAL, 'carol');
			open();
			await editing;
			assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} @carol:example.org`), ['@carol:example.org']);
		});
	});

	// ---- kit fix round 3 (grok e2t delta2 F1-F5): the pill id goes in only for an id Rocket.Chat can show, at a word position ----
	describe('kfix3', () => {

		describe('offers', () => {
			const setup = async () => {
				const b = fixtureBridge();
				const src = new BridgeSource(b);
				src.history(GENERAL);
				return { b, src };
			};

			it('kfix3 F4: a send whose outcome room is an existing DM keeps that DM\'s own earlier offers', async () => {
				const { b, src } = await setup();
				const DM = '!dm:example.org';
				(src as unknown as { offered: Map<string, Map<string, number>> }).offered.set(DM, new Map([['@carol:example.org', 1]]));
				const orig = b.sendText as NonNullable<typeof b.sendText>;
				(b as { sendText: unknown }).sendText = async (...a: Parameters<typeof orig>) => ({ ...(await orig(...a)), roomId: DM });
				await src.mentionCandidates(GENERAL, 'bo');
				await src.sendText(GENERAL, `${BOB} hi`, 'rc-h1');
				src.moveOffered(GENERAL, DM);
				assert.deepEqual(src.mentionsIn(DM, '@carol:example.org hi'), ['@carol:example.org']);
				assert.deepEqual(src.mentionsIn(DM, `${BOB} hi`), []);
			});

			const gated = (b: ReturnType<typeof fixtureBridge>, key: 'sendText' | 'mentionCandidates') => {
				const orig = (b as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[key];
				let open!: () => void;
				const wait = new Promise<void>((r) => (open = r));
				(b as unknown as Record<string, unknown>)[key] = async (...a: unknown[]) => {
					await wait;
					return orig.apply(b, a);
				};
				return open;
			};

			it('kfix3 F5: a candidate request started before a send and answered during its flight is dropped by that send', async () => {
				const { b, src } = await setup();
				const openSend = gated(b, 'sendText');
				await src.mentionCandidates(GENERAL, 'bo'); // a pick the draft holds
				const openAsk = gated(b, 'mentionCandidates');
				const asking = src.mentionCandidates(GENERAL, 'carol'); // started before the send
				const sending = src.sendText(GENERAL, `${BOB} @carol:example.org`, 'rc-i1');
				openAsk();
				await asking; // answered during the flight
				openSend();
				await sending;
				assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} @carol:example.org`), []);
			});

			it('kfix3 F5: a request started during the flight survives that send', async () => {
				const { b, src } = await setup();
				const openSend = gated(b, 'sendText');
				await src.mentionCandidates(GENERAL, 'bo');
				const sending = src.sendText(GENERAL, `${BOB} first`, 'rc-j1');
				await src.mentionCandidates(GENERAL, 'carol'); // started and answered during the flight
				openSend();
				await sending;
				assert.deepEqual(src.mentionsIn(GENERAL, `${BOB} @carol:example.org`), ['@carol:example.org']);
			});
		});
	});

	// ---- kit fix round 4 (grok track-code F1-F3): the id grammar has no emphasis delimiter at its edges, a late answer neither revives nor lowers an offer, a trailing `.` is no word position ----
	describe('kfix4', () => {

		describe('offers', () => {
			const setup = () => {
				const b = fixtureBridge();
				const src = new BridgeSource(b);
				src.history(GENERAL);
				return { b, src };
			};
			// The next call of `key` waits until the returned function opens it; later calls run ungated.
			const gateNext = (b: ReturnType<typeof fixtureBridge>, key: 'sendText' | 'mentionCandidates') => {
				const rec = b as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
				const orig = rec[key];
				let open!: () => void;
				const wait = new Promise<void>((r) => (open = r));
				rec[key] = async (...a: unknown[]) => {
					rec[key] = orig;
					await wait;
					return orig.apply(b, a);
				};
				return open;
			};

			it('kfix4 F2: an answer that arrives after a send already dropped its request is discarded', async () => {
				const { b, src } = setup();
				const openAsk = gateNext(b, 'mentionCandidates');
				const asking = src.mentionCandidates(GENERAL, 'carol'); // started before the send
				await src.sendText(GENERAL, `${BOB} hi`, 'rc-k1'); // the send completes first
				openAsk();
				await asking; // the answer lands after the drop
				assert.deepEqual(src.mentionsIn(GENERAL, '@carol:example.org hi'), []);
			});

			it('kfix4 F2: an older request finishing last does not lower a newer stamp (Carol survives the send)', async () => {
				const { b, src } = setup();
				const openAsk = gateNext(b, 'mentionCandidates');
				const older = src.mentionCandidates(GENERAL, 'carol'); // request A
				const openSend = gateNext(b, 'sendText');
				const sending = src.sendText(GENERAL, `${BOB} hi`, 'rc-k2'); // starts after A
				await src.mentionCandidates(GENERAL, 'carol'); // request B, started and answered during the flight
				openAsk();
				await older; // A answers last
				openSend();
				await sending;
				assert.deepEqual(src.mentionsIn(GENERAL, '@carol:example.org hi'), ['@carol:example.org']);
			});

			it('kfix4 F2: the dropped-up-to watermark follows moveOffered (local id to real id)', async () => {
				const { src } = setup();
				await src.sendText(GENERAL, 'plain', 'rc-k3');
				const dropped = (src as unknown as { dropped: Map<string, number> }).dropped;
				const mark = dropped.get(GENERAL);
				assert.equal(typeof mark, 'number');
				src.moveOffered(GENERAL, '!real:example.org');
				assert.equal(dropped.has(GENERAL), false);
				assert.equal(dropped.get('!real:example.org'), mark);
			});
		});
	});

	describe('received pills (row rewrite cut)', () => {
		const pill = (id: string, name: string) => `<a href="https://matrix.to/#/${encodeURIComponent(id)}">${name}</a>`;

		it('a pill message renders the display name in msg and sets no mentions', () => {
			const m = pillMsg('Bob: hello Bob', `${pill(BOB, 'Bob')}: hello Bob`);
			assert.equal(m.msg, 'Bob: hello Bob');
			assert.equal('mentions' in m, false);
			const two = pillMsg('A & B Carol', `${pill('@a:hs', 'A &amp; B')} ${pill('@carol:hs', 'Carol')}`);
			assert.equal(two.msg, 'A & B Carol');
			assert.equal('mentions' in two, false);
		});

		it('an id in an href never appears in msg', () => {
			for (const id of ['@a.__x__.b:evil.com', '@x:y](https://evil.example)', '@bob:[::1]', '@bob:example.org:8448']) {
				const m = pillMsg('Hi Bob', `Hi ${pill(id, 'Bob')}`);
				assert.equal(m.msg, 'Hi Bob', id);
				assert.equal(m.msg.includes('evil'), false, id);
				assert.equal('mentions' in m, false, id);
			}
		});

		it('formatting around the name still converts', () => {
			const m = pillMsg('__bold__ Bob', `<strong>bold</strong> ${pill('@bob:example.org', 'Bob')}`);
			assert.equal(m.msg, '**bold** Bob');
			assert.equal('mentions' in m, false);
		});

		it('private-use characters in the body stay as they are', () => {
			const m = pillMsg('\uf8ff Bob \uf8fe', `\uf8ff ${pill('@bob:example.org', 'Bob')} \uf8fe`);
			assert.equal(m.msg, '\uf8ff Bob \uf8fe');
		});
	});

	it('a message without pills has no mentions field', () => {
		const m = bridge.timeline(GENERAL)[1];
		assert.equal('mentions' in toMessage(m), false);
		assert.equal('mentions' in toMessage({ ...m, body: 'x', formattedBody: '<a href="https://example.org">x</a>' }), false);
	});
});

describe('quote jump room match and failure (M9 Q fix1)', () => {
	const old = (id: string, minAgo: number) => ({ id, roomId: GENERAL, senderId: '@bob:example.org', senderName: 'Bob', body: id, ts: Date.now() - minAgo * 60_000, kind: 'text' as const });
	const room = (r: { _id: string; t?: string; name?: string }) => r as Parameters<typeof roomPath>[0] & object;
	const generalPath = () => roomPath(getSource().rooms().find((r) => r._id === GENERAL));
	const setPath = (p: string) => { (globalThis as { window: { location: { hash: string } } }).window.location.hash = `#${p}`; };
	let previousHash = '';
	beforeEach(() => { previousHash = (globalThis as { window: { location: { hash: string } } }).window.location.hash; });
	afterEach(() => { (globalThis as { window: { location: { hash: string } } }).window.location.hash = previousHash; setJumpFailed(() => undefined); bridge.olderResult = undefined; });

	it('routeShowsRoom: the room path, with a tab and a context segment; a direct id encoded twice; not another room', () => {
		const ch = room({ _id: '!a:x', t: 'c', name: 'general' });
		const dm = room({ _id: 'local+1/x%', t: 'd', name: 'bob' });
		assert.equal(routeShowsRoom(ch, '/channel/general'), true);
		assert.equal(routeShowsRoom(ch, '/channel/general/threads'), true);
		assert.equal(routeShowsRoom(ch, '/channel/general/thread/abc'), true);
		assert.equal(routeShowsRoom(ch, '/channel/general/thread/abc/extra'), false);
		assert.equal(routeShowsRoom(ch, '/channel/general2'), false);
		assert.equal(routeShowsRoom(ch, '/channel/random/threads'), false);
		assert.equal(routeShowsRoom(dm, roomPath(dm)), true);
		assert.equal(routeShowsRoom(dm, `${roomPath(dm).replace(/%/g, '%25')}/threads`), true, 'twice encoded id with a tab');
		assert.equal(routeShowsRoom(dm, '/direct/other'), false);
	});

	it('chat.getMessage pages back on a route with a tab segment, and not on another room\'s route', async () => {
		const src = getSource();
		src.history(GENERAL);
		bridge.olderPages[GENERAL] = [[old('$tabq1', 70)]];
		setPath(`${generalPath()}/threads?msg=%2524tabq1`);
		const got = (await sdk.rest.get('/v1/chat.getMessage', { msgId: '$tabq1' })) as { message: { _id: string } };
		assert.equal(got.message._id, '$tabq1');
		const calls = bridge.olderCalls.length;
		bridge.olderPages[GENERAL] = [[old('$tabq2', 80)]];
		setPath(`${roomPath(src.rooms().find((r) => r._id === RANDOM))}?msg=%2524tabq2`);
		await assert.rejects(sdk.rest.get('/v1/chat.getMessage', { msgId: '$tabq2' }), /not in the history/);
		assert.equal(bridge.olderCalls.length, calls, 'another room is on screen: no page back');
	});

	it('a loadOlder rejection inside chat.getMessage toasts the jump failure when ?msg names the id, then rethrows', async () => {
		const src = getSource();
		src.history(GENERAL);
		const toasts: string[] = [];
		setJumpFailed((m) => toasts.push(m));
		const original = (bridge as { loadOlder?: unknown }).loadOlder;
		const b = bridge as unknown as { loadOlder: (...a: unknown[]) => Promise<unknown> };
		b.loadOlder = () => Promise.reject(new Error('older history refused'));
		try {
			setPath(`${generalPath()}?msg=%2524boom`);
			await assert.rejects(sdk.rest.get('/v1/chat.getMessage', { msgId: '$boom' }), /older history refused/);
			assert.deepEqual(toasts, ['older history refused']);
			setPath(generalPath());
			await assert.rejects(sdk.rest.get('/v1/chat.getMessage', { msgId: '$boom' }), /older history refused/);
			assert.equal(toasts.length, 1, 'no ?msg for this id: no toast');
		} finally {
			b.loadOlder = original as typeof b.loadOlder;
		}
	});
});

describe('M13 U3: a failed first send in a created local chat (D1 restore in the real room, D2 echo and resend)', () => {
	// The local chat id is NOT among the fixture rooms; RANDOM is the real room the host made (its error names it, additive `roomId`).
	const LOCAL = 'local-dm-u3';
	const post = (rid: string, msg: string, _id: string) => sdk.rest.post('/v1/chat.sendMessage', { message: { _id, rid, msg } });
	type Fx = ReturnType<typeof fixtureBridge>;
	// The host's send refuses after the room was created: the error carries the real room (or not, for the old shape).
	const rejectWith = (b: Fx, roomId?: string) => {
		const send = b.sendText;
		b.sendText = async (rid, text, opts) => {
			b.sent.push({ roomId: rid, text, txnId: opts?.txnId });
			if (roomId) {
				// the host's room list follows the created room a moment later (an earlier test may have removed RANDOM from the shared fixture)
				if (!b.rooms().some((r) => r.id === roomId)) b.rooms().push({ id: roomId, name: 'Random', unreadCount: 0, mentionCount: 0, isDirect: true, order: 9 });
				setTimeout(() => b.emit({ kind: 'rooms' }), 0);
			}
			throw Object.assign(new Error('not allowed'), { code: 'forbidden', ...(roomId ? { roomId } : {}) });
		};
		return () => void (b.sendText = send);
	};
	const until = async (done: () => boolean, ms = 4000) => {
		for (let t = 0; t < ms && !done(); t += 20) await new Promise((r) => setTimeout(r, 20));
	};
	const opened: string[] = [];
	const restored: string[][] = [];
	let composerReady = 0; // the restore refuses (false) until this many calls were made: the route has not reached the real room yet
	const kept: string[][] = []; // the text that went into Rocket.Chat's own draft of a room (no composer kept it)
	beforeEach(() => {
		opened.length = 0;
		restored.length = 0;
		kept.length = 0;
		composerReady = 0;
		setRoomOpener((rid: string) => void opened.push(rid));
		setRestoreComposer((rid, text) => (restored.push([rid, text]), restored.length >= composerReady));
		wiring.saveDraft = (rid, text) => void kept.push([rid, text]);
	});
	afterEach(() => {
		setRoomOpener(() => undefined);
		setRestoreComposer(() => undefined);
		delete wiring.composerHolds;
		delete wiring.saveDraft;
	});

	it('(a) an error naming the real room: the real room opens and the draft is restored THERE, polled until its composer exists', async () => {
		composerReady = 3; // false, false, true
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft a', 'rc-u3-a'), /not allowed/);
			await until(() => restored.length >= 3);
			await new Promise((r) => setTimeout(r, 300)); // a true answer ends the polling: no fourth call
		} finally {
			undo();
		}
		assert.deepEqual(opened, [RANDOM], 'the real room is opened in place of the local one');
		assert.deepEqual(restored, [[RANDOM, 'u3 draft a'], [RANDOM, 'u3 draft a'], [RANDOM, 'u3 draft a']], 'three tries, all in the real room, none in the local one');
	});

	it('(b) an error without a room (the old shape, or creation failed): today\'s path, the draft goes back to the room it was typed in, nothing is opened', async () => {
		const undo = rejectWith(bridge);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft b', 'rc-u3-b'), /not allowed/);
			await new Promise((r) => setTimeout(r, 200));
		} finally {
			undo();
		}
		assert.deepEqual(opened, []);
		assert.deepEqual(restored, [[LOCAL, 'u3 draft b']]);
	});

	it('(c) the real room is not shown by the kit: the draft goes back on the local id, nothing is opened', async () => {
		const src = getSource();
		const shown = src.roomShown;
		src.roomShown = async () => false;
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft c', 'rc-u3-c'), /not allowed/);
			await until(() => restored.length >= 1);
			await new Promise((r) => setTimeout(r, 200));
		} finally {
			undo();
			src.roomShown = shown;
		}
		assert.deepEqual(opened, []);
		assert.deepEqual(restored, [[LOCAL, 'u3 draft c']]);
	});

	it('(c2) the real room is not shown AND the local room already left the list (the host drops a created chat before the rejection arrives): the text goes to Rocket.Chat\'s draft of the REAL room, not to the local id (grok track F1)', async () => {
		const src = getSource();
		const shown = src.roomShown;
		src.roomShown = async () => false;
		setRestoreComposer((rid, text) => (restored.push([rid, text]), false)); // restoreComposerText: the local id is no longer in rooms()
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft c2', 'rc-u3-c2'), /not allowed/);
			await until(() => kept.length >= 1);
		} finally {
			undo();
			src.roomShown = shown;
		}
		assert.deepEqual(opened, []);
		assert.deepEqual(restored, [[LOCAL, 'u3 draft c2']], 'one try at the local composer');
		assert.deepEqual(kept, [[RANDOM, 'u3 draft c2']]);
	});

	it('(f1) the first restore wrote into the previous view\'s composer (the route moved before the view did): it is not done until the real room\'s textarea still holds the text', async () => {
		composerReady = 1; // every restore answers true
		const checks: string[] = [];
		wiring.composerHolds = (rid, text) => (checks.push(`${rid}:${text}`), checks.length >= 2); // the first check finds the new textarea empty
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft f1', 'rc-u3-f1'), /not allowed/);
			await until(() => checks.length >= 2);
			await new Promise((r) => setTimeout(r, 300));
		} finally {
			undo();
		}
		assert.deepEqual(restored, [[RANDOM, 'u3 draft f1'], [RANDOM, 'u3 draft f1']], 'written again once the first write was found gone');
		assert.equal(checks.length, 2, 'a confirmed restore ends the polling');
		assert.deepEqual(kept, [], 'a lasting restore needs no draft');
	});

	it('(f2) a restore that throws is one more try, not the end of the polling', async () => {
		let calls = 0;
		setRestoreComposer((rid, text) => {
			restored.push([rid, text]);
			if (++calls === 1) throw new Error('composer not reachable yet');
			return true;
		});
		wiring.composerHolds = () => true;
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft f2', 'rc-u3-f2'), /not allowed/);
			await until(() => restored.length >= 2);
			await new Promise((r) => setTimeout(r, 300));
		} finally {
			undo();
		}
		assert.deepEqual(restored, [[RANDOM, 'u3 draft f2'], [RANDOM, 'u3 draft f2']]);
		assert.deepEqual(kept, []);
	});

	it('(f3) no lasting restore in the window: the text goes into Rocket.Chat\'s draft of the real room (it shows when that composer mounts)', async () => {
		composerReady = 1_000_000; // the composer never comes up
		const undo = rejectWith(bridge, RANDOM);
		try {
			await assert.rejects(post(LOCAL, 'u3 draft f3', 'rc-u3-f3'), /not allowed/);
			await until(() => kept.length >= 1, 8000);
		} finally {
			undo();
		}
		assert.ok(restored.length >= 10, `polled for the window (${restored.length} tries)`);
		assert.ok(restored.every(([rid]) => rid === RANDOM), 'every try in the real room');
		assert.deepEqual(kept, [[RANDOM, 'u3 draft f3']]);
	});

	it('(g) a retry from the composer that still addresses the LOCAL id reuses the stored transaction id; a later send from the real room then finds none (F2)', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const undo = rejectWith(b, RANDOM);
		await assert.rejects(src.sendText(LOCAL, 'u3 retry', 'rc-u3-g1'), /not allowed/);
		undo();
		await src.sendText(LOCAL, 'u3 retry', 'rc-u3-g2');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-u3-g1', 'the local retry reuses the failed send\'s id');
		await src.sendText(RANDOM, 'u3 retry', 'rc-u3-g3');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-u3-g3', 'the id was consumed by the retry: the next send is a new message');
	});

	it('(h) a failure naming the real room, a retry from the local composer that fails again keeps one stored id for both composers (F2)', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const undo = rejectWith(b, RANDOM);
		await assert.rejects(src.sendText(LOCAL, 'u3 twice', 'rc-u3-h1'), /not allowed/);
		await assert.rejects(src.sendText(LOCAL, 'u3 twice', 'rc-u3-h2'), /not allowed/);
		undo();
		await src.sendText(RANDOM, 'u3 twice', 'rc-u3-h3');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-u3-h1', 'the first id survives both failures');
	});

	it('(d) the homeserver holds the message in the real room (its echo carries the txnId): the row stays, the outcome is done with that room', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const seen: string[] = [];
		src.onChange((c) => c.kind === 'message' && seen.push(`${c.op}:${(c.doc as { _id: string })._id}`));
		b.sendText = async (_rid, text, opts) => {
			b.putMessage(RANDOM, { id: '$u3-echo', roomId: RANDOM, senderId: '@alice:example.org', senderName: 'Alice', body: text, ts: Date.now(), kind: 'text', txnId: opts?.txnId });
			throw Object.assign(new Error('connection lost'), { code: 'network', roomId: RANDOM });
		};
		const outcome = await src.sendText(LOCAL, 'u3 arrived', 'rc-u3-d');
		assert.deepEqual(outcome, { status: 'done', roomId: RANDOM, eventId: '$u3-echo' });
		assert.ok(!seen.some((s) => s.startsWith('removed:')), `no row withdrawn: ${seen.join(',')}`);
	});

	it('(e) after a failure naming the real room, a resend of the same text in THAT room reuses the transaction id (one message, not two)', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const undo = rejectWith(b, RANDOM);
		await assert.rejects(src.sendText(LOCAL, 'u3 again', 'rc-u3-e1'), /not allowed/);
		undo();
		await src.sendText(RANDOM, 'u3 again', 'rc-u3-e2');
		assert.equal(b.sent.at(-1)!.roomId, RANDOM);
		assert.equal(b.sent.at(-1)!.txnId, 'rc-u3-e1', 'the resend in the real room reuses the failed send\'s id');
		await src.sendText(LOCAL, 'u3 other', 'rc-u3-e3');
		assert.equal(b.sent.at(-1)!.txnId, 'rc-u3-e3', 'the local room keeps no stored id');
	});
});
