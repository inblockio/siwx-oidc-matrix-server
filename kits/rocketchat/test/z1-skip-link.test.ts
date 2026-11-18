// M12 Z1 (D41 wire): the skip link moves the focus to the main content. Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { MAIN_CONTENT_ID, focusMainContent, type FocusTarget } from '../src/skip-link.ts';

/** A stand-in for `<main>`: attributes, a blur listener, and which attribute value it held when focus() was called. */
const fakeMain = (initialTabindex: string | null = null) => {
	const attrs = new Map<string, string>();
	if (initialTabindex !== null) attrs.set('tabindex', initialTabindex);
	let onBlur: (() => void) | undefined;
	const log: { focusedWithTabindex: (string | null)[] } = { focusedWithTabindex: [] };
	const el: FocusTarget = {
		getAttribute: (n) => attrs.get(n) ?? null,
		setAttribute: (n, v) => void attrs.set(n, v),
		removeAttribute: (n) => void attrs.delete(n),
		addEventListener: (_t, l) => void (onBlur = l),
		focus: () => void log.focusedWithTabindex.push(attrs.get('tabindex') ?? null),
	};
	return { el, attrs, blur: () => onBlur?.(), log };
};

describe('focusMainContent', () => {
	it('asks for the element main-content and returns false when the page has none', () => {
		const asked: string[] = [];
		assert.equal(MAIN_CONTENT_ID, 'main-content');
		assert.equal(focusMainContent({ getElementById: (id) => (asked.push(id), null) }), false);
		assert.deepEqual(asked, ['main-content']);
	});

	it('makes the main region focusable before it focuses it, and gives that back on blur', () => {
		const m = fakeMain();
		assert.equal(focusMainContent({ getElementById: () => m.el }), true);
		assert.deepEqual(m.log.focusedWithTabindex, ['-1'], 'focused exactly once, already with tabindex -1');
		assert.equal(m.attrs.get('tabindex'), '-1', 'still focusable while it holds the focus');
		m.blur();
		assert.equal(m.attrs.has('tabindex'), false, 'tabindex is removed on blur');
	});

	it('leaves a tabindex the page set itself alone', () => {
		const m = fakeMain('0');
		assert.equal(focusMainContent({ getElementById: () => m.el }), true);
		assert.deepEqual(m.log.focusedWithTabindex, ['0']);
		m.blur();
		assert.equal(m.attrs.get('tabindex'), '0', 'not ours, not removed');
	});
});

describe('kit wiring', () => {
	it('swaps Rocket.Chat AccessibilityShortcut for the kit copy', () => {
		const cfg = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
		assert.match(cfg, /replaceFile\(\/[^\n]*AccessibilityShortcut\\\.tsx\$\/, src\('accessibility-shortcut\.tsx'\)\)/);
	});

	it('keeps Rocket.Chat markup (a link to #main-content, the Skip_to_main_content label) and stops the navigation', () => {
		const src = readFileSync(new URL('../src/accessibility-shortcut.tsx', import.meta.url), 'utf8');
		assert.match(src, /is='a'/);
		assert.match(src, /#\$\{MAIN_CONTENT_ID\}/);
		assert.match(src, /Skip_to_main_content/);
		assert.match(src, /event\.preventDefault\(\)/);
		assert.match(src, /focusMainContent\(/);
	});
});
