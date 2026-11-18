// M11 X3 (D41): the composer's KaTeX button, Timestamp entry and WebDAV "Add Server" are removed.
// Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HIDE_ACTIONS, HIDE_SETTINGS } from '../src/hide-actions.ts';

// Copied from test/x2-hidden.test.ts (D39's three, then D41's ten). Not recomputed.
const X2_MESSAGE = [
	'star-message',
	'unstar-message',
	'start-discussion',
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

const KATEX_CONDITION = join(homedir(), '.cache/element-views-track/rocket.chat/apps/meteor/client/lib/messageBoxFormatting.ts');

describe('X3 hide', () => {
	it('hides timestamp and webdav-add with create-discussion, and leaves the other toolboxes', () => {
		assert.deepEqual(HIDE_ACTIONS.composerToolbox, ['create-discussion', 'timestamp', 'webdav-add', 'share-location']);
		assert.deepEqual(HIDE_ACTIONS.roomToolbox, ['mentions', 'starred-messages', 'discussions']);
		for (const id of X2_MESSAGE) assert.ok(HIDE_ACTIONS.messageToolbox.includes(id), id);
		assert.equal(HIDE_ACTIONS.messageToolbox.length, X2_MESSAGE.length);
	});

	it('answers Katex_Enabled false', () => {
		assert.deepEqual(HIDE_SETTINGS, { Katex_Enabled: false });
	});

	it('spreads HIDE_SETTINGS into the SETTINGS table', () => {
		const sdk = readFileSync(new URL('../src/adapter/sdk.ts', import.meta.url), 'utf8');
		const start = sdk.indexOf('const SETTINGS');
		assert.notEqual(start, -1);
		const tail = sdk.slice(start);
		const end = tail.search(/^};/m);
		assert.notEqual(end, -1);
		const body = tail.slice(0, end);
		assert.match(body, /\bHIDE_SETTINGS\b/);
		assert.match(body, /\.\.\.HIDE_SETTINGS\b/);
	});

	it('keeps the KaTeX condition as settings.peek(\'Katex_Enabled\') ?? true', (t) => {
		if (!existsSync(KATEX_CONDITION)) {
			t.skip('Rocket.Chat checkout is absent');
			return;
		}
		// The `?? true` is why the setting must be answered false, not left unset.
		assert.match(readFileSync(KATEX_CONDITION, 'utf8'), /settings\.peek\('Katex_Enabled'\) \?\? true/);
	});
});
