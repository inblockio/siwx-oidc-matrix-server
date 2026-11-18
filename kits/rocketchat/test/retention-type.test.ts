// M4 (decision D15): the system-message type room_retention_changed registers from kit source, and its text is the
// notice the host sent. The registration module takes the registry as an argument, so the test needs no Rocket.Chat
// package install: it uses Rocket.Chat's own MessageTypes class from the read-only checkout when present.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RETENTION_TYPE_ID, registerRetentionType } from '../src/retention-type.ts';

const RC_CLASS = join(homedir(), '.cache/element-views-track/rocket.chat/packages/message-types/src/MessageTypes.ts');

describe('room_retention_changed registration', () => {
	it('registers one system type whose text is the message text, untouched, whatever the translation function', () => {
		const seen: { id: string; system: boolean; text: (t: never, m: { msg: string }) => string }[] = [];
		registerRetentionType({ registerType: (o) => seen.push(o as never) });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].id, 'room_retention_changed');
		assert.equal(RETENTION_TYPE_ID, 'room_retention_changed');
		assert.equal(seen[0].system, true);
		const text = 'turned off <i>disappearing</i> messages & *more*.';
		assert.equal(seen[0].text((() => 'wrong') as never, { msg: text }), text);
	});

	it('with Rocket.Chat\'s own MessageTypes class: getType finds it and it counts as a system message', { skip: !existsSync(RC_CLASS) }, async () => {
		const { MessageTypes } = await import(RC_CLASS);
		const registry = new MessageTypes();
		assert.equal(registry.getType({ t: 'room_retention_changed' }), undefined, 'unknown before');
		registerRetentionType(registry);
		const type = registry.getType({ t: 'room_retention_changed' });
		assert.equal(type?.text((() => 'wrong') as never, { msg: 'set messages in this room to disappear after 7 days.' }), 'set messages in this room to disappear after 7 days.');
		assert.equal(registry.isSystemMessage({ t: 'room_retention_changed' }), true);
	});
});
