// M12 X4 (D41, ruling FN5): the composer's "+" (More actions) is not drawn while its menu lists no item.
// Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isMenuWithoutItem, menuItemCount } from '../src/menu-empty.ts';

const RC_ROOT = join(homedir(), '.cache/element-views-track/rocket.chat');
const RC_TOOLBAR = join(RC_ROOT, 'apps/meteor/client/views/room/composer/messageBox/MessageBoxActionsToolbar/MessageBoxActionsToolbar.tsx');
const RC_MENU = join(RC_ROOT, 'packages/ui-client/src/components/GenericMenu/GenericMenu.tsx');

describe('the empty rule counts items, not sections', () => {
	it('is empty for the two titled sections Rocket.Chat passes when every item is hidden (>= 480 px composer)', () => {
		const menu = { sections: [{ title: 'Create new', items: [] }, { title: 'Share', items: [] }] };
		assert.equal(menuItemCount(menu), 0);
		assert.equal(isMenuWithoutItem(menu), true);
	});

	it('is not empty with the Video message in "Create new" (< 480 px composer)', () => {
		const menu = { sections: [{ title: 'Create new', items: [{ id: 'video-message' }] }, { title: 'Share', items: [] }] };
		assert.equal(menuItemCount(menu), 1);
		assert.equal(isMenuWithoutItem(menu), false);
	});

	it('counts an item in any section, and every item of a section', () => {
		assert.equal(menuItemCount({ sections: [{ items: [] }, { items: [{ id: 'a' }, { id: 'b' }] }, { items: [{ id: 'c' }] }] }), 3);
		assert.equal(isMenuWithoutItem({ sections: [{ items: [] }, { items: [], title: 'Insert' }, { items: [{ id: 'app' }] }] }), false);
	});

	it('does not count a missing (undefined) entry as an item', () => {
		assert.equal(isMenuWithoutItem({ sections: [{ items: [undefined, undefined] }] }), true);
	});

	it('is empty for no sections, a section without items, and an empty or absent flat list; counts a flat list', () => {
		assert.equal(isMenuWithoutItem({ sections: [] }), true);
		assert.equal(isMenuWithoutItem({ sections: [{}] }), true);
		assert.equal(isMenuWithoutItem({ items: [] }), true);
		assert.equal(isMenuWithoutItem({}), true);
		assert.equal(menuItemCount({ items: [{ id: 'a' }, { id: 'b' }] }), 2);
	});
});

describe('the swap is wired to the composer toolbar only', () => {
	const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');

	it('registers a ui-client replacement filtered by the composer toolbar as issuer, onto composer-menu.tsx', () => {
		assert.match(webpack, /const hideEmptyComposerMenu = new webpack\.NormalModuleReplacementPlugin\(\/\^@rocket\\\.chat\\\/ui-client\$\//);
		assert.match(webpack, /MessageBoxActionsToolbar\\\.tsx\$\/\.test\(data\.contextInfo\?\.issuer/);
		assert.match(webpack, /data\.request = src\('composer-menu\.tsx'\)/);
		assert.match(webpack, /\n\t\thideEmptyComposerMenu,\n/);
		assert.equal(existsSync(new URL('../src/composer-menu.tsx', import.meta.url)), true);
	});

	it('wraps Rocket.Chat GenericMenu and hides it by the item rule', () => {
		const source = readFileSync(new URL('../src/composer-menu.tsx', import.meta.url), 'utf8');
		assert.match(source, /import \{ GenericMenu as OriginalGenericMenu \} from '@rocket\.chat\/ui-client'/);
		assert.match(source, /isMenuWithoutItem\(props\) \? null : <OriginalGenericMenu \{\.\.\.props\} \/>/);
	});
});

describe('Rocket.Chat still draws the "+" with empty sections', () => {
	it('keeps the composer menu on GenericMenu from ui-client, with fixed sections, and the section-count rule', (t) => {
		if (!existsSync(RC_ROOT)) {
			t.skip('Rocket.Chat checkout is absent');
			return;
		}
		const toolbar = readFileSync(RC_TOOLBAR, 'utf8');
		assert.match(toolbar, /import \{ GenericMenu(, type GenericMenuItemProps)? \} from '@rocket\.chat\/ui-client'/);
		assert.match(toolbar, /data-qa-id='menu-more-actions'/);
		assert.match(toolbar, /\{ title: t\('Create_new'\), items: createNewFiltered \}/);
		assert.match(toolbar, /\{ title: t\('Share'\), items: shareFiltered \}/);
		// Its own empty rule counts sections, so the two fixed sections never make the menu empty.
		assert.match(readFileSync(RC_MENU, 'utf8'), /!\(sections && sections\.length > 0\)/);
	});
});
