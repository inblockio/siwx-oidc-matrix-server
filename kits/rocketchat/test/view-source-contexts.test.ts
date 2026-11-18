// E5 fix 1 (track F1): View source is not offered on a call card. The host has no event row behind a call card
// (openViewSource would reject unknown_event), so the item's contexts exclude both call contexts, like Report (E4).
// Run: node --test kits/rocketchat/test/.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEW_SOURCE_CONTEXTS } from '../src/view-source-contexts.ts';

describe('View source contexts (E5 fix 1)', () => {
	it('exclude the call card contexts', () => {
		assert.ok(!VIEW_SOURCE_CONTEXTS.includes('videoconf'));
		assert.ok(!VIEW_SOURCE_CONTEXTS.includes('videoconf-threads'));
	});
	it('still offer View source on a message, a thread message, a starred or a federated one', () => {
		for (const c of ['message', 'message-mobile', 'threads', 'starred', 'federated']) assert.ok(VIEW_SOURCE_CONTEXTS.includes(c), c);
	});
});
