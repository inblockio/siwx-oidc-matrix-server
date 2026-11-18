// M9: the kit's reaction to the host's jump and room-open requests.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PanelEventSource } from '../src/panel-events-core.ts';

// panel-events.ts imports the Rocket.Chat-bundled modules only through its default wiring; the unit imports the pure part.
const load = async () => (await import('../src/panel-events-core.ts')).watchPanelEvents;

describe('watchPanelEvents', () => {
	const make = (route: Record<string, string | undefined>, names: Record<string, string> = {}) => {
		let jumpCb: (j: { roomId: string; id: string }) => void = () => undefined;
		let roomCb: (j: { roomId: string; id?: string }) => void = () => undefined;
		let off = 0;
		const source: PanelEventSource = {
			onJump: (cb) => ((jumpCb = cb), () => void off++),
			onRoomOpen: (cb) => ((roomCb = cb), () => void off++),
			roomShown: async (rid) => rid !== '!gone:x',
			room: (rid) => (names[rid] ? { name: names[rid] } : undefined),
		};
		const calls: string[] = [];
		return { source, calls, router: { getRouteParameters: () => route }, jump: (id: string) => void calls.push(`jump:${id}`), openRoom: (rid: string) => void calls.push(`open:${rid}`), fire: { jump: (j: { roomId: string; id: string }) => jumpCb(j), room: (j: { roomId: string; id?: string }) => roomCb(j) }, offs: () => off };
	};

	it('jumps in place when the route shows the panel room (by rid or by name), else opens the room first', async () => {
		const watch = await load();
		const a = make({ rid: 'R1' });
		watch(a);
		a.fire.jump({ roomId: 'R1', id: 'x' });
		assert.deepEqual(a.calls, ['jump:x']);
		const b = make({ name: 'general' }, { R1: 'general' });
		watch(b);
		b.fire.jump({ roomId: 'R1', id: 'y' });
		assert.deepEqual(b.calls, ['jump:y']);
		const c = make({ rid: 'R2' });
		watch(c);
		c.fire.jump({ roomId: 'R1', id: 'z' });
		assert.deepEqual(c.calls, ['open:R1', 'jump:z']);
	});

	it('opens a room the host asks for once the bridge shows it, never a room it does not show, and unsubscribes both', async () => {
		const watch = await load();
		const m = make({});
		const stop = watch(m);
		m.fire.room({ roomId: 'R9' });
		m.fire.room({ roomId: '!gone:x' });
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(m.calls, ['open:R9']);
		stop();
		assert.equal(m.offs(), 2);
	});

	it('A2: a room-open with an event opens the room, then jumps to that event; a room never shown does neither', async () => {
		const watch = await load();
		const m = make({});
		watch(m);
		m.fire.room({ roomId: 'R9', id: 'hit1' });
		m.fire.room({ roomId: '!gone:x', id: 'hit2' });
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(m.calls, ['open:R9', 'jump:hit1']);
	});
});
