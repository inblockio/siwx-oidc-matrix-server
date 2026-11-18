// M11 Y4 (D41 wire): "Reply in direct message" opens, or starts, Element's direct chat with the sender (bridge.startDm). Who gets the
// item, what the press does with the outcome, and the bundler swap that wires it. Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';
import { replyDirectlyShown, runReplyDirectly } from '../src/reply-directly-flow.ts';

const gate = { original: true, canStartDm: true, senderId: '@bob:example.org', ownId: '@alice:example.org' };

describe('replyDirectlyShown', () => {
	it('shows the item for another user\'s message where Rocket.Chat offers it and the host can start a chat', () => {
		assert.equal(replyDirectlyShown(gate), true);
	});

	it('hides it for your own message (N6: no chat with yourself)', () => {
		assert.equal(replyDirectlyShown({ ...gate, senderId: '@alice:example.org' }), false);
	});

	it('hides it on a host without startDm, and where Rocket.Chat offers no item', () => {
		assert.equal(replyDirectlyShown({ ...gate, canStartDm: false }), false);
		assert.equal(replyDirectlyShown({ ...gate, original: false }), false);
	});

	it('shows it while the own id is not known yet, but never for a sender without an id', () => {
		assert.equal(replyDirectlyShown({ ...gate, ownId: undefined }), true);
		assert.equal(replyDirectlyShown({ ...gate, senderId: '' }), false);
	});
});

describe('runReplyDirectly', () => {
	const harness = () => {
		const b = fixtureBridge();
		const calls: string[] = [];
		const deps = {
			startDm: (id: string, fromRoomId?: string) => b.startDm(id, fromRoomId),
			openRoom: (rid: string) => void calls.push(`room:${rid}`),
			fail: (e: unknown) => void calls.push(`fail:${(e as Error).message}`),
		};
		return { b, calls, deps };
	};

	it('asks for the chat with the sender and opens the room it answers with', async () => {
		const { b, calls, deps } = harness();
		await runReplyDirectly(deps, '@bob:example.org');
		assert.deepEqual(b.dmCalls, ['@bob:example.org']);
		assert.deepEqual(calls, ['room:!dm-bob:example.org']);
	});

	it('passes the room of the message on, so the host titles a new chat from the person on that message (M12 Z2 F1)', async () => {
		const { b, calls, deps } = harness();
		await runReplyDirectly(deps, '@bob:example.org', '!here:example.org');
		assert.deepEqual(b.dmCalls, ['@bob:example.org']);
		assert.deepEqual(b.dmFromRooms, ['!here:example.org']);
		assert.deepEqual(calls, ['room:!dm-bob:example.org']);
	});

	it('an existing chat opens as it is', async () => {
		const { b, calls, deps } = harness();
		b.roomResult.startDm = { roomId: '!bob:example.org' };
		await runReplyDirectly(deps, '@bob:example.org');
		assert.deepEqual(calls, ['room:!bob:example.org']);
	});

	it('a backed-out chat opens nothing and toasts nothing', async () => {
		const { b, calls, deps } = harness();
		b.roomResult.startDm = { status: 'cancelled' };
		await runReplyDirectly(deps, '@bob:example.org');
		assert.deepEqual(calls, []);
	});

	it('a failure is the error toast and opens nothing', async () => {
		const { b, calls, deps } = harness();
		b.roomResult.startDm = Object.assign(new Error('Element could not start the chat'), { code: 'failed' });
		await runReplyDirectly(deps, '@bob:example.org');
		assert.deepEqual(calls, ['fail:Element could not start the chat']);
	});
});

describe('the press passes the message\'s room id (M12 Z2 F1)', () => {
	it('reply-directly-action hands message.rid to the flow as the room of the message', () => {
		const wrapper = readFileSync(new URL('../src/reply-directly-action.ts', import.meta.url), 'utf8');
		assert.match(wrapper, /startDm: \(id, fromRoomId\) => getSource\(\)\.startDm\(id, fromRoomId\)/);
		assert.match(wrapper, /message\.u\.username as string,\s*(\/\/[^\n]*\n\s*)*message\.rid,/);
	});
});

describe('webpack swap of Reply in direct message (D41 wire)', () => {
	const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
	const swaps = [...webpack.matchAll(/replaceFile\(\/(.+?)\/,\s*src\('([^']+)'\)\)/g)].map((m) => ({ re: new RegExp(m[1]), file: m[2] }));
	it('swaps RC\'s useReplyInDMAction by its own file, and the wrapper imports the original through the ?kit-original query', () => {
		const path = 'apps/meteor/client/components/message/toolbar/useReplyInDMAction.ts';
		assert.equal(swaps.filter((s) => s.re.test(path) && s.file === 'reply-directly-action.ts').length, 1);
		assert.equal(existsSync(new URL('../src/reply-directly-action.ts', import.meta.url)), true);
		const wrapper = readFileSync(new URL('../src/reply-directly-action.ts', import.meta.url), 'utf8');
		assert.match(wrapper, /useReplyInDMAction\.ts\?kit-original/);
		assert.equal(swaps.some((s) => s.re.test(`${path}?kit-original`)), false, 'the original, with its query, is not swapped');
	});
});
