// M10 X2 (D41): the controls with no Element equivalent are removed. Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { HIDE_ACTIONS } from '../src/hide-actions.ts';
import adminMenu from '../src/admin-menu.ts';
import { useStatusItems } from '../src/status-items.ts';
import threadFollow from '../src/thread-follow.ts';
import { hasCategoryMenu, moveEdges, withoutDisplayPrefs, withoutEmptyStatusSection, withoutHideRoom } from '../src/x2-filters.ts';

const D39_MESSAGE = ['star-message', 'unstar-message', 'start-discussion'];
const D41_MESSAGE = [
	'mark-message-as-unread',
	'follow-message',
	'unfollow-message',
	'translate',
	'view-original',
	'reaction-list',
	'webdav-upload',
	'jump-to-message',
	'jump-to-pin-message',
	'jump-to-star-message',
];

describe('HIDE_ACTIONS', () => {
	it('hides the three D39 message ids and the ten D41 ids, and leaves the other toolboxes', () => {
		for (const id of [...D39_MESSAGE, ...D41_MESSAGE]) {
			assert.ok(HIDE_ACTIONS.messageToolbox.includes(id), id);
		}
		assert.equal(HIDE_ACTIONS.messageToolbox.includes('reply-directly'), false);
		assert.deepEqual(HIDE_ACTIONS.roomToolbox, ['mentions', 'starred-messages', 'discussions']);
		assert.deepEqual(HIDE_ACTIONS.composerToolbox, ['create-discussion', 'timestamp', 'webdav-add', 'share-location']);
		const layout = readFileSync(new URL('../src/layout-provider.tsx', import.meta.url), 'utf8');
		assert.match(layout, /export \{ HIDE_ACTIONS \}/);
		assert.match(layout, /import \{ HIDE_ACTIONS \} from '\.\/hide-actions\.ts'/);
	});
});

describe('withoutDisplayPrefs', () => {
	const display = { title: 'Display', items: [{ id: 'extended' }, { id: 'medium' }, { id: 'condensed' }, { id: 'avatars' }] };
	const sortBy = { title: 'Sort by', items: [{ id: 'activity' }, { id: 'name' }] };
	const groupBy = { title: 'Group by', items: [{ id: 'unread' }, { id: 'favorites' }, { id: 'types' }] };

	it('keeps Sort by and drops view mode, avatars and grouping, including a section whose items are all removed', () => {
		const input = [display, sortBy, groupBy];
		const before = structuredClone(input);
		const out = withoutDisplayPrefs(input);
		assert.deepEqual(out, [{ title: 'Sort by', items: [{ id: 'activity' }, { id: 'name' }] }]);
		assert.equal(out[0].title, 'Sort by');
		assert.deepEqual(input, before);
		assert.equal(input[1].items, sortBy.items);
	});

	it('works without a Display section (the secondary sidebar) and keeps an unknown id', () => {
		const secondary = [sortBy, groupBy];
		assert.deepEqual(withoutDisplayPrefs(secondary), [{ title: 'Sort by', items: [{ id: 'activity' }, { id: 'name' }] }]);
		const withUnknown = [{ title: 'Sort by', items: [{ id: 'activity' }, { id: 'future-sort' }] }];
		const before = structuredClone(withUnknown);
		assert.deepEqual(withoutDisplayPrefs(withUnknown), [{ title: 'Sort by', items: [{ id: 'activity' }, { id: 'future-sort' }] }]);
		assert.deepEqual(withUnknown, before);
	});
});

describe('withoutHideRoom', () => {
	it('removes hideRoom only, keeps the order of the rest, drops an empty section, and keeps an empty input empty', () => {
		const input = [{ title: 'room', items: [{ id: 'toggleFavorite' }, { id: 'markUnread' }, { id: 'leaveRoom' }, { id: 'hideRoom' }] }];
		const before = structuredClone(input);
		assert.deepEqual(withoutHideRoom(input), [
			{ title: 'room', items: [{ id: 'toggleFavorite' }, { id: 'markUnread' }, { id: 'leaveRoom' }] },
		]);
		assert.deepEqual(input, before);
		assert.deepEqual(withoutHideRoom([{ title: 'room', items: [{ id: 'hideRoom' }] }]), []);
		assert.deepEqual(withoutHideRoom([]), []);
	});
});

describe('withoutEmptyStatusSection', () => {
	it('drops an empty Status section, keeps the header and a section that has items, and does not mutate the input', () => {
		const header = { title: {} as object, items: [] as { id?: string }[] };
		const account = { title: 'Account', items: [{ id: 'x' }] };
		const input = [{ title: 'Status', items: [] as { id?: string }[] }, header, account];
		const before = structuredClone(input);
		const out = withoutEmptyStatusSection(input);
		assert.deepEqual(out, [header, account]);
		assert.equal(out[0], header);
		assert.equal(out[1], account);
		assert.deepEqual(input, before);
	});
});

describe('moveEdges (M11 Y3)', () => {
	const ids = ['a', 'b', 'c'];
	it('the first custom cannot move up, the last cannot move down, a middle one can do both', () => {
		assert.deepEqual(moveEdges(ids, 'a', true), { canMoveUp: false, canMoveDown: true });
		assert.deepEqual(moveEdges(ids, 'b', true), { canMoveUp: true, canMoveDown: true });
		assert.deepEqual(moveEdges(ids, 'c', true), { canMoveUp: true, canMoveDown: false });
	});
	it('a single custom, an unknown id and a host without category move move nowhere', () => {
		assert.deepEqual(moveEdges(['only'], 'only', true), { canMoveUp: false, canMoveDown: false });
		assert.deepEqual(moveEdges(ids, 'gone', true), { canMoveUp: false, canMoveDown: false });
		assert.deepEqual(moveEdges([], '', true), { canMoveUp: false, canMoveDown: false });
		assert.deepEqual(moveEdges(ids, 'b', false), { canMoveUp: false, canMoveDown: false });
	});
});

describe('hasCategoryMenu', () => {
	it('is false for the built-in groups (no category, or a default one) and true for a custom category', () => {
		assert.equal(hasCategoryMenu(undefined), false);
		assert.equal(hasCategoryMenu({ _id: 'Favorites', name: 'Favorites', default: true }), false);
		assert.equal(hasCategoryMenu({ _id: 'Channels', name: 'Channels', default: true }), false);
		assert.equal(hasCategoryMenu({ _id: 'element.io.section.abc', name: 'Projects' }), true);
	});
});

describe('the thin swaps', () => {
	it('useStatusItems returns nothing, and the follow bell and the Manage menu render nothing', () => {
		assert.deepEqual(useStatusItems(), []);
		assert.equal(threadFollow(), null);
		assert.equal(adminMenu(), null);
	});
});

describe('webpack swaps', () => {
	const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
	const swaps = [...webpack.matchAll(/replaceFile\(\/(.+?)\/,\s*src\('([^']+)'\)\)/g)].map((match) => ({
		re: new RegExp(match[1]),
		file: match[2],
	}));
	const rows: [string, string][] = [
		['apps/meteor/client/navbar/NavBarPagesGroup/hooks/useSortMenu.ts', 'sort-menu.ts'],
		['apps/meteor/client/hooks/useRoomMenuActions.ts', 'room-menu-actions.ts'],
		['apps/meteor/client/views/navigation/sidepanel/hooks/useRoomMenuActions.ts', 'sidepanel-room-menu-actions.ts'],
		['apps/meteor/client/components/message/content/ThreadMetricsFollow.tsx', 'thread-follow.ts'],
		['apps/meteor/client/navbar/NavBarSettingsToolbar/UserMenu/hooks/useStatusItems.tsx', 'status-items.ts'],
		['apps/meteor/client/navbar/NavBarSettingsToolbar/NavBarItemAdministrationMenu.tsx', 'admin-menu.ts'],
		['apps/meteor/client/hooks/useSortQueryOptions.ts', 'sort-query-options.ts'],
	];

	it('matches each D41 path with its own swap, and a ?kit-original path with none of them', () => {
		const six = rows.map(([path, file]) => {
			const hits = swaps.filter((swap) => swap.re.test(path) && swap.file === file);
			assert.equal(hits.length, 1, `${path} -> ${file}`);
			assert.equal(existsSync(new URL(`../src/${file}`, import.meta.url)), true, file);
			return hits[0];
		});
		const byFile = (file: string) => six.find((swap) => swap.file === file)!;
		assert.equal(byFile('room-menu-actions.ts').re.test(rows[2][0]), false);
		assert.equal(byFile('sidepanel-room-menu-actions.ts').re.test(rows[1][0]), false);
		assert.equal(byFile('sort-query-options.ts').re.test('apps/meteor/client/hooks/useSortQueryOptions.spec.ts'), false);
		for (const [path] of rows) {
			assert.equal(
				six.some((swap) => swap.re.test(`${path}?kit-original`)),
				false,
				`${path}?kit-original`,
			);
		}
	});

	it('ungates the group header, swaps CategoryMenu for a copy without the unread toggles (D41 hide)', () => {
		const line = webpack.split('\n').find((entry) => entry.includes('const UNGATED_SITES'));
		assert.ok(line);
		const body = line.match(/const UNGATED_SITES = \/(.+)\/;/)?.[1];
		assert.ok(body);
		const ungated = new RegExp(body);
		assert.equal(ungated.test('apps/meteor/client/sidebar/RoomList/RoomListCollapser.tsx'), true);
		const menu = swaps.filter((swap) => swap.re.test('apps/meteor/client/sidebar/categories/CategoryMenu.tsx'));
		assert.deepEqual(menu.map((swap) => swap.file), ['category-menu.tsx']);
		const source = readFileSync(new URL('../src/category-menu.tsx', import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '');
		for (const gone of ['show-unreads', 'keep-unreads-on-top', 'Always_display', 'Keep_on_top', 'useToggleUnreads', 'sidebarShowUnread', 'ToggleSwitch']) {
			assert.equal(source.includes(gone), false, gone);
		}
		for (const kept of ['move-up', 'move-down', "'manage'", "'delete'", 'Create_new']) assert.equal(source.includes(kept), true, kept);
		// M11 Y3: the move items call the host's `moveSection`, never Rocket.Chat's own preference writers.
		assert.match(source, /getSource\(\)\s*\.moveSection\(/);
		for (const gone of ['setCategory', 'useMoveCategoryPosition', 'useSetCategory']) assert.equal(source.includes(gone), false, gone);
		// Built-in groups get no menu at all (nothing but N/A items would show): the exported component renders through the helper.
		assert.match(source, /hasCategoryMenu\(/);
	});
});
