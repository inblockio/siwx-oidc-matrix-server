// Capability table parser (H4): the shipped CAPABILITIES.md parses to the scaffold rows, malformed tables are refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseCapabilities, parseUnansweredCalls } from '../src/capabilities.ts';

const HEAD = '| id | selector | presence | status | reason |\n|---|---|---|---|---|\n';

describe('CAPABILITIES.md', () => {
	it('parses the shipped table: composer, room kebab (hidden D41) and Leave, admin entry, connection retry (hidden D41), the wired E2EE signal, replies and reactions rows, the wired reaction add and toggle, the hidden (D41) message toolbar and the wired quick reactions, the wired thread summary row and the interim thread open and hidden (D41) follow rows, the wired media and URL preview rows, the hidden (D41) document viewer, then the E3 triage of the navbar, user menu, sidebar, room header, composer and message-level functions', () => {
		const rows = parseCapabilities(readFileSync(new URL('../CAPABILITIES.md', import.meta.url), 'utf8'));
		assert.deepEqual(
			rows.map(({ id, presence, status }) => [id, presence, status]),
			[
				['composer-send', 'shown', 'interim (D16)'],
				['composer-emoji', 'shown', 'wired'],
				['composer-formatting', 'shown', 'interim (D31)'],
				['composer-mentions', 'hidden', 'interim (D31)'],
				['composer-katex', 'hidden', 'hidden (D41)'],
				['composer-av-message', 'shown', 'wired'],
				['composer-more', 'hidden', 'interim (D41)'],
				['composer-timestamp', 'hidden', 'hidden (D41)'],
				['composer-webdav', 'hidden', 'hidden (D41)'],
				['composer-location', 'hidden', 'hidden (D41)'],
				['room-kebab', 'hidden', 'hidden (D41)'],
				['room-item-actions', 'hidden', 'wired'],
				['room-leave', 'hidden', 'wired'],
				['admin-entry', 'hidden', 'hidden (D41)'],
				['connection-retry', 'hidden', 'hidden (D41)'],
				['e2ee-signal', 'hidden', 'wired'],
				['replies', 'hidden', 'wired'],
				['reactions', 'hidden', 'wired'],
				['reaction-add', 'hidden', 'wired'],
				['reaction-toggle', 'hidden', 'wired'],
				['message-toolbar', 'hidden', 'hidden (D41)'],
				['reaction-quick', 'hidden', 'wired'],
				['message-quote', 'hidden', 'interim (D16)'],
				['message-thread-reply', 'hidden', 'interim (D37)'],
				['message-forward', 'hidden', 'interim (D31)'],
				['message-quote-jump', 'hidden', 'interim (D40)'],
				['message-menu', 'hidden', 'wired'],
				['message-edit', 'hidden', 'interim (D16/D20)'],
				['message-delete', 'hidden', 'interim (D16/D20)'],
				['message-menu-local', 'hidden', 'wired'],
				['message-pin', 'hidden', 'wired'],
				['message-view-source', 'hidden', 'interim (D31)'],
				['message-report', 'hidden', 'interim (D31)'],
				['message-copy-markdown', 'hidden', 'wired'],
				['message-menu-hidden', 'hidden', 'hidden (D41)'],
				['message-reply-direct', 'hidden', 'interim (D41)'],
				['user-info', 'shown', 'interim (D41)'],
				['message-menu-other', 'hidden', 'hidden (D41)'],
				['thread-summary', 'hidden', 'wired'],
				['thread-open', 'hidden', 'interim (D37)'],
				['thread-follow', 'hidden', 'hidden (D41)'],
				['media-image', 'hidden', 'wired'],
				['media-file', 'hidden', 'wired'],
				['media-video', 'hidden', 'wired'],
				['media-audio', 'hidden', 'wired'],
				['url-preview', 'hidden', 'wired'],
				['media-download', 'hidden', 'wired'],
				['document-viewer', 'hidden', 'hidden (D41)'],
				['media-actions', 'hidden', 'hidden (D41)'],
				['media-reveal', 'hidden', 'interim (D41)'],
				['directory', 'shown', 'interim (D41)'],
				['display-sort', 'shown', 'interim (D41)'],
				['display-prefs', 'hidden', 'hidden (D41)'],
				['create-new', 'shown', 'wired'],
				['room-join', 'hidden', 'interim (D16)'],
				['room-invite', 'hidden', 'interim (D16)'],
				['search', 'shown', 'wired'],
				['search-server', 'hidden', 'interim (D41)'],
				['history', 'shown', 'wired'],
				['older-messages', 'hidden', 'wired'],
				['user-menu', 'shown', 'wired'],
				['status-custom', 'hidden', 'hidden (D41)'],
				['status-presets', 'hidden', 'hidden (D41)'],
				['account-profile', 'user-menu', 'interim (D41)'],
				['account-preferences', 'user-menu', 'interim (D41)'],
				['account-accessibility', 'user-menu', 'interim (D41)'],
				['account-feature-preview', 'user-menu', 'interim (D41)'],
				['shortcuts', 'user-menu', 'wired'],
				['switch-view', 'user-menu', 'wired'],
				['logout', 'user-menu', 'interim (D16)'],
				['sidebar-groups', 'shown', 'wired'],
				['category-move', 'hidden', 'wired'],
				['category-new', 'hidden', 'wired'],
				['category-unreads', 'hidden', 'hidden (D41)'],
				['category-rename', 'hidden', 'interim (D41)'],
				['category-delete', 'hidden', 'interim (D41)'],
				['category-create-new', 'hidden', 'wired'],
				['category-manage', 'hidden', 'interim (D41)'],
				['room-favorite', 'shown', 'wired'],
				['room-notifications', 'hidden', 'wired'],
				['room-info', 'shown', 'interim (D39)'],
				['room-search', 'shown', 'interim (D39)'],
				['room-mentions', 'hidden', 'hidden (D39)'],
				['room-members', 'shown', 'interim (D39)'],
				['room-files', 'shown', 'interim (D39)'],
				['room-starred', 'hidden', 'hidden (D39)'],
				['room-discussions', 'hidden', 'hidden (D39)'],
				['room-pinned', 'shown', 'interim (D39)'],
				['upload', 'shown', 'wired'],
				['call-tile', 'hidden', 'hand-off (D26)'],
				['call-start', 'hidden', 'hand-off (D26)'],
				['encryption-event', 'shown', 'interim (D41)'],
				['retention-notice', 'shown', 'wired'],
				['retention-expired', 'shown', 'wired'],
				['retention-indicator-list', 'shown', 'wired'],
				['retention-indicator-header', 'shown', 'wired'],
				['skip-to-main-content', 'shown', 'wired'],
			],
		);
		// The composer is split: the text box and send button are interim (D16), every other control stays N/A.
		assert.match(rows[0].selector, /textarea\[name="msg"\]/);
		assert.match(rows[0].reason, /awaits a composer send view-model.*MessageComposerUrlPreviewViewModel/i);
		assert.ok(rows.every((row) => row.reason.length > 10));
		// M10 W4: the Profile item opens Element's settings dialog; it is interim (D41) and names the action it awaits.
		const profile = rows.find((row) => row.id === 'account-profile');
		assert.match(profile?.reason ?? '', /awaits an open-settings action.*UserMenuViewModel/i);
		// M10 W6: the Display menu's sort radios drive Element's sort; one row (the radios sit in a closed menu), interim (D41).
		const sort = rows.find((row) => row.id === 'display-sort');
		assert.match(sort?.reason ?? '', /awaits a sort action.*RoomListHeaderViewModel/i);
		assert.match(sort?.reason ?? '', /`activity`.*`name`.*setRoomSort.*unread-first/is);
		assert.equal(rows.filter((row) => row.id.startsWith('display-sort')).length, 1);
		// M12 X4b (G2 default b): the read-receipt item has no Element equivalent and is removed, the reason says why.
		const receipts = rows.find((row) => row.id === 'message-menu-other');
		assert.match(receipts?.reason ?? '', /no per-message read list.*G2 default b/is);
		assert.equal(receipts?.selector, '[data-key="receipt-detail"]');
	});

	it('accepts the interim (D16) status when its reason names the view-model it awaits', () => {
		const rows = parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D16) | Awaits a composer send view-model. |`);
		assert.equal(rows[0].status, 'interim (D16)');
	});

	it('accepts the interim (D16/D20) status under the same awaits rule', () => {
		const rows = parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D16/D20) | Awaits a composer send view-model. |`);
		assert.equal(rows[0].status, 'interim (D16/D20)');
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D16/D20) | Not wired. |`), /interim \(D16\/D20\) row's reason/);
	});

	it('accepts the interim (D41) status under the same awaits rule', () => {
		const rows = parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D41) | Awaits a directory view-model. |`);
		assert.equal(rows[0].status, 'interim (D41)');
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D41) | Not wired. |`), /interim \(D41\) row's reason/);
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | shown | interim (D41) |  |`), /interim \(D41\) row's reason/);
	});

	it('stops at the end of the table and keeps a wired row without a reason', () => {
		const rows = parseCapabilities(`intro\n\n${HEAD}| a | \`.a\` | shown | wired |  |\n\nafter | not a row |`);
		assert.deepEqual(rows, [{ id: 'a', selector: '.a', presence: 'shown', status: 'wired', reason: '' }]);
	});

	it('accepts the user-menu presence: a row that renders only inside the open user menu', () => {
		const rows = parseCapabilities(`${HEAD}| a | \`[data-key="a"]\` | user-menu | wired |  |`);
		assert.equal(rows[0].presence, 'user-menu');
	});

	for (const [name, row] of [
		['an N/A row without a reason', '| a | `.a` | shown | N/A |  |'],
		['an interim (D16) row without a reason', '| a | `.a` | shown | interim (D16) |  |'],
		['an interim (D16) row whose reason names no awaited view-model', '| a | `.a` | shown | interim (D16) | works fine |'],
		['an unknown status', '| a | `.a` | shown | partial | x |'],
		['an unknown presence', '| a | `.a` | maybe | wired |  |'],
		['a selector without backticks', '| a | .a | shown | wired |  |'],
	]) {
		it(`refuses ${name}`, () => assert.throws(() => parseCapabilities(HEAD + row), /capabilities:/));
	}

	it('refuses a hidden (D41) row whose presence is shown', () => {
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | shown | hidden (D41) | No Element equivalent (D41): gone. |`), /presence is hidden/);
	});

	it('refuses a hidden (D41) row without a reason', () => {
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | hidden | hidden (D41) |  |`), /needs a reason/);
	});

	it('refuses a duplicate id, an empty table and a missing table', () => {
		assert.throws(() => parseCapabilities(`${HEAD}| a | \`.a\` | shown | wired |  |\n| a | \`.b\` | shown | wired |  |`), /duplicate id a/);
		assert.throws(() => parseCapabilities(HEAD), /empty table/);
		assert.throws(() => parseCapabilities('no table'), /no table/);
	});
});

const CALLS = '| call | row | reason |\n|---|---|---|\n';
const NA_ROWS = parseCapabilities(`${HEAD}| composer | \`.c\` | shown | N/A | no send |\n| shown-wired | \`.w\` | shown | wired |  |`);

describe('the unanswered-call table of CAPABILITIES.md', () => {
	it('maps every call to an N/A row of the shipped table or to none with a reason', () => {
		const markdown = readFileSync(new URL('../CAPABILITIES.md', import.meta.url), 'utf8');
		const calls = parseUnansweredCalls(markdown, parseCapabilities(markdown));
		assert.ok(calls.length >= 12);
		assert.deepEqual(calls.find((c) => c.call === '/v1/spotlight')?.row, 'none', 'W5 answers the sidebar lookup with empty lists');
		assert.deepEqual(calls.find((c) => c.call === 'stream-user-presence')?.row, 'none');
		assert.ok(calls.every((c) => c.reason.length > 10));
	});

	it('parses call, row and reason, and stops at the end of the table', () => {
		const calls = parseUnansweredCalls(`intro\n\n${CALLS}| \`/v1/a\` | composer | needs a send |\n| \`b\` | none | background lookup |\n\nafter`);
		assert.deepEqual(calls, [
			{ call: '/v1/a', row: 'composer', reason: 'needs a send' },
			{ call: 'b', row: 'none', reason: 'background lookup' },
		]);
	});

	it('is not confused by the capability table before it', () => {
		const calls = parseUnansweredCalls(`${HEAD}| a | \`.a\` | shown | wired |  |\n\n${CALLS}| \`/v1/a\` | none | nothing renders |`);
		assert.equal(calls.length, 1);
	});

	for (const [name, row] of [
		['a call without backticks', '| /v1/a | none | why |'],
		['a call without a reason', '| `/v1/a` | none |  |'],
		['a call without a row', '| `/v1/a` |  | why |'],
	]) {
		it(`refuses ${name}`, () => assert.throws(() => parseUnansweredCalls(CALLS + row), /unanswered calls:/));
	}

	it('refuses a duplicate call, an empty table and a missing table', () => {
		assert.throws(() => parseUnansweredCalls(`${CALLS}| \`a\` | none | x y |\n| \`a\` | none | x y |`), /duplicate call a/);
		assert.throws(() => parseUnansweredCalls(CALLS), /empty table/);
		assert.throws(() => parseUnansweredCalls('no table'), /no table/);
	});

	it('refuses a row that is not in the capability table or is not N/A, when the rows are given', () => {
		assert.throws(() => parseUnansweredCalls(`${CALLS}| \`/v1/a\` | nope | why |`, NA_ROWS), /unanswered calls: \/v1\/a: row nope/);
		assert.throws(() => parseUnansweredCalls(`${CALLS}| \`/v1/a\` | shown-wired | why |`, NA_ROWS), /row shown-wired is not N\/A/);
		assert.equal(parseUnansweredCalls(`${CALLS}| \`/v1/a\` | composer | why |`, NA_ROWS).length, 1);
		const interim = parseCapabilities(`${HEAD}| i | \`.i\` | shown | interim (D16) | awaits a send view-model |`);
		assert.throws(() => parseUnansweredCalls(`${CALLS}| \`/v1/a\` | i | why |`, interim), /row i is not N\/A/);
	});
});
