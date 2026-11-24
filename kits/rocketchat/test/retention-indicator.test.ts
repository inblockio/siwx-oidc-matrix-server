// Room retention indicator (owner's ruling 2026-11-24), kit half: the host's ViewRoom.retention reaches the room and the
// subscription documents, follows the setting, and the two swaps are wired. Expected values are the task's, not the
// implementation's. Run: node --test kits/rocketchat/test/ (Node >= 22.18 strips the types).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ViewRoom } from '../src/bridge-types.ts';
import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';
import { RETENTION_INDICATOR_FIELD, retentionIndicatorFields, retentionIndicatorOf } from '../src/retention-indicator.ts';

// A minimal window before any module that reads it at load (as in adapter.test.ts).
const win: Record<string, unknown> = {
	location: { pathname: '/kits/rocketchat/index.html', hash: '', origin: 'http://localhost', search: '' },
	history: {},
	localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
	__clientViewBridge: fixtureBridge(),
};
win.parent = win;
Object.assign(globalThis, { window: win });

const { BridgeSource } = await import('../src/adapter/source.ts');
const { toRoom, toSubscription } = await import('../src/adapter/map.ts');

const GENERAL = '!general:example.org';
const RANDOM = '!random:example.org';
const TWO_WEEKS = {
	maxLifetimeMs: 14 * 86400000,
	period: '2 weeks',
	listLabel: 'Messages are deleted after 2 weeks',
	headerText: 'Messages here are deleted after 2 weeks',
};
const ONE_DAY = {
	maxLifetimeMs: 86400000,
	period: '1 day',
	listLabel: 'Messages are deleted after 1 day',
	headerText: 'Messages here are deleted after 1 day',
};
const me = { userId: '@me:example.org', displayName: 'Me' } as Parameters<typeof toRoom>[2];
const viewRoom = (over: Partial<ViewRoom> = {}): ViewRoom => ({
	id: GENERAL,
	name: 'General Chat',
	unreadCount: 0,
	mentionCount: 0,
	isDirect: false,
	order: 0,
	isFavourite: false,
	canMarkAsUnread: true,
	notificationLevel: 'all_messages',
	...over,
});

describe('retention indicator fields', () => {
	it('carries the host\'s two texts for a room with clean-up, under a field that is not Rocket.Chat\'s own `retention`', () => {
		assert.equal(RETENTION_INDICATOR_FIELD, 'retentionIndicator');
		assert.deepEqual(retentionIndicatorFields(viewRoom({ retention: TWO_WEEKS })), {
			retentionIndicator: { listLabel: 'Messages are deleted after 2 weeks', headerText: 'Messages here are deleted after 2 weeks' },
		});
	});

	it('adds nothing for a room without clean-up, an older host or a malformed value', () => {
		assert.deepEqual(retentionIndicatorFields(viewRoom()), {});
		assert.deepEqual(retentionIndicatorFields(viewRoom({ retention: { ...TWO_WEEKS, listLabel: '' } })), {});
		assert.deepEqual(retentionIndicatorFields(viewRoom({ retention: { ...TWO_WEEKS, headerText: 7 as unknown as string } })), {});
	});

	it('reads the indicator back from a document, and nothing from Rocket.Chat\'s own retention policy or junk', () => {
		assert.deepEqual(retentionIndicatorOf({ retentionIndicator: { listLabel: 'a', headerText: 'b' } }), { listLabel: 'a', headerText: 'b' });
		assert.equal(retentionIndicatorOf({ retention: { enabled: true, maxAge: 14 } }), undefined);
		assert.equal(retentionIndicatorOf({ retentionIndicator: { listLabel: 'a' } }), undefined);
		assert.equal(retentionIndicatorOf({ retentionIndicator: 'a' }), undefined);
		assert.equal(retentionIndicatorOf(undefined), undefined);
		assert.equal(retentionIndicatorOf(null), undefined);
	});

	it('toRoom (header) and toSubscription (sidebar) carry it, and leave the key out without clean-up', () => {
		const room = toRoom(viewRoom({ retention: TWO_WEEKS }), 'general', me, 1_000_000) as unknown as Record<string, unknown>;
		const sub = toSubscription(viewRoom({ retention: TWO_WEEKS }), 'general', me, 1_000_000) as unknown as Record<string, unknown>;
		assert.equal(retentionIndicatorOf(room)?.headerText, 'Messages here are deleted after 2 weeks');
		assert.equal(retentionIndicatorOf(sub)?.listLabel, 'Messages are deleted after 2 weeks');
		assert.equal(room.retention, undefined, 'Rocket.Chat\'s own retention policy stays unset');
		assert.equal('retentionIndicator' in (toRoom(viewRoom(), 'general', me, 1_000_000) as object), false);
		assert.equal('retentionIndicator' in (toSubscription(viewRoom(), 'general', me, 1_000_000) as object), false);
	});
});

describe('retention indicator in the room source', () => {
	const fresh = () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const seen: string[] = [];
		src.onChange((c) => seen.push(`${c.op}:${c.kind}:${(c.doc as { _id: string })._id}`));
		return { b, src, seen };
	};
	const subOf = (src: InstanceType<typeof BridgeSource>, rid: string) => src.subscriptions().find((s) => s.rid === rid)!;
	const roomOf = (src: InstanceType<typeof BridgeSource>, rid: string) => src.rooms().find((r) => r._id === rid)!;

	it('a room switched on, changed and off is a changed room and a later subscription each time', () => {
		const { b, src, seen } = fresh();
		const general = b.rooms().find((r) => r.id === GENERAL)!;
		assert.equal(retentionIndicatorOf(subOf(src, GENERAL)), undefined);
		assert.equal(retentionIndicatorOf(roomOf(src, GENERAL)), undefined);

		let stamp = +subOf(src, GENERAL)._updatedAt;
		for (const [retention, label, text] of [
			[TWO_WEEKS, 'Messages are deleted after 2 weeks', 'Messages here are deleted after 2 weeks'],
			[ONE_DAY, 'Messages are deleted after 1 day', 'Messages here are deleted after 1 day'],
			[undefined, undefined, undefined],
		] as const) {
			seen.length = 0;
			if (retention) general.retention = retention;
			else delete general.retention;
			b.emit({ kind: 'rooms' });
			assert.equal(retentionIndicatorOf(subOf(src, GENERAL))?.listLabel, label);
			assert.equal(retentionIndicatorOf(roomOf(src, GENERAL))?.headerText, text);
			assert.ok(seen.includes(`changed:subscription:s-${GENERAL}`), seen.join(','));
			assert.ok(seen.includes(`changed:room:${GENERAL}`), seen.join(','));
			// Rocket.Chat's sidebar item re-renders only for a newer _updatedAt
			assert.ok(+subOf(src, GENERAL)._updatedAt > stamp, 'the subscription is a later update');
			stamp = +subOf(src, GENERAL)._updatedAt;
		}
		assert.equal('retentionIndicator' in subOf(src, GENERAL), false, 'switched off: the field is gone, not empty');
	});

	it('an unchanged setting emits nothing and keeps the stamp; other rooms are untouched', () => {
		const { b, src, seen } = fresh();
		b.rooms().find((r) => r.id === GENERAL)!.retention = TWO_WEEKS;
		b.emit({ kind: 'rooms' });
		const stamp = +subOf(src, GENERAL)._updatedAt;
		seen.length = 0;
		b.emit({ kind: 'rooms' });
		assert.deepEqual(seen, []);
		assert.equal(+subOf(src, GENERAL)._updatedAt, stamp);
		assert.equal(retentionIndicatorOf(subOf(src, RANDOM)), undefined);
	});
});

describe('retention indicator swaps', () => {
	const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

	it('webpack swaps Rocket.Chat\'s sidebar row and room title for the two wrappers', () => {
		const cfg = read('../webpack.config.js');
		assert.match(cfg, /replaceFile\(\/client\\\/sidebar\\\/RoomList\\\/SidebarItemTemplateWithData\\\.tsx\$\/, src\('sidebar-item-retention\.tsx'\)\)/);
		assert.match(cfg, /replaceFile\(\/client\\\/views\\\/room\\\/Header\\\/RoomTitle\\\.tsx\$\/, src\('room-title-retention\.tsx'\)\)/);
	});

	it('each wrapper renders the original (imported past the swap) and draws only with an indicator', () => {
		const sidebar = read('../src/sidebar-item-retention.tsx');
		assert.match(sidebar, /from 'rc\/client\/sidebar\/RoomList\/SidebarItemTemplateWithData\.tsx\?kit-original'/);
		assert.match(sidebar, /retentionIndicatorOf\(props\.room\)\?\.listLabel/);
		assert.match(sidebar, /if \(!label\) return <Template \{\.\.\.props\} \/>;/);
		assert.match(sidebar, /role='img'/);
		assert.match(sidebar, /aria-label=\{label\}/);
		assert.match(sidebar, /title=\{label\}/);
		assert.match(sidebar, /aria-describedby=\{id\}/);
		assert.match(sidebar, /data-kit-retention-clock=''/);
		// the clock comes after Rocket.Chat's room icon, so right before the name
		assert.match(sidebar, /\{props\.icon\}\s*<RetentionClock/);
		const title = read('../src/room-title-retention.tsx');
		assert.match(title, /from 'rc\/client\/views\/room\/Header\/RoomTitle\.tsx\?kit-original'/);
		assert.match(title, /retentionIndicatorOf\(props\.room\)\?\.headerText/);
		assert.match(title, /\{text && \(/);
		assert.match(title, /data-kit-retention-text=''/);
		assert.match(title, /withTruncatedText/);
	});
});
