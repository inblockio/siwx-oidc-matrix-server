// The call window (lane CALL, C1/C3): opened blank with its opener cut, then navigated; reused by focus; a closed window
// falls back to the plain open. Run: node --test kits/rocketchat/test/ (Node >= 22.18 strips the types).
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CONFERENCE_WINDOW_NAME, createCallWindowOpener } from '../src/call-window-open.ts';

type Fake = { closed: boolean; opener: unknown; location: { href: string }; readonly navigations: string[]; focused: number; focus: () => void };
type Call = { url: string; name: string; features?: string };

// A fake browser: `open(url, name)` of an existing named window finds it, else
// `answers` decides: a window, a closed window or null (blocked). A new window always starts with an opener (the opener frame).
const makeBrowser = (answers: Array<'window' | 'closed' | 'blocked'>) => {
	const calls: Call[] = [];
	const named = new Map<string, Fake>();
	const make = (closed: boolean): Fake => {
		const navigations: string[] = [];
		let href = 'about:blank';
		const fake: Fake = {
			closed,
			opener: { frame: 'kit' },
			navigations,
			focused: 0,
			focus() {
				fake.focused++;
			},
			location: {
				get href() {
					return href;
				},
				set href(v: string) {
					href = v;
					navigations.push(v);
				},
			},
		};
		return fake;
	};
	const host = {
		open(url: string, name: string, features?: string): Window | null {
			calls.push({ url, name, features });
			const known = named.get(name);
			if (known && !known.closed) {
				if (url && url !== 'about:blank') known.location.href = url;
				return known as unknown as Window;
			}
			const answer = answers.shift() ?? 'window';
			if (answer === 'blocked') return null;
			const fresh = make(answer === 'closed');
			if (answer === 'window') named.set(name, fresh);
			return fresh as unknown as Window;
		},
	};
	return { host, calls, named };
};

const FEATURES = 'popup=yes,width=1280,height=800';
const URL_A = 'https://meet.example/#/room/!a%3Alocalhost';
const URL_B = 'https://meet.example/#/room/!b%3Alocalhost';

describe('call window', () => {
	let b: ReturnType<typeof makeBrowser>;
	beforeEach(() => {
		b = makeBrowser([]);
	});

	it('opens the named window blank, cuts its opener, then navigates it to the call address', () => {
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const win = open(URL_A) as unknown as Fake;
		assert.ok(win);
		assert.equal(win.opener, null);
		assert.deepEqual(win.navigations, [URL_A]);
		// The address never went through window.open (that call would hand the new window an opener).
		assert.deepEqual(b.calls, [{ url: '', name: CONFERENCE_WINDOW_NAME, features: FEATURES }]);
	});

	it('a window of that name still open from before a kit reload is found by name and not blanked', () => {
		const old = makeBrowser(['window']);
		const first = createCallWindowOpener(old.host, () => FEATURES)(URL_A) as unknown as Fake;
		// The kit reloads: a new opener has no memory of the window, the browser still has it, running the call.
		const reloaded = createCallWindowOpener(old.host, () => FEATURES);
		const found = reloaded(URL_A) as unknown as Fake;
		assert.equal(found, first);
		assert.ok(
			old.calls.every((c) => c.url === ''),
			'no open call carries an address, so the running call is not blanked',
		);
	});

	it('a second open of the same address focuses the window: no new window, no navigation, opener still null', () => {
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const first = open(URL_A) as unknown as Fake;
		const again = open(URL_A) as unknown as Fake;
		assert.equal(again, first);
		assert.equal(again.opener, null);
		assert.deepEqual(first.navigations, [URL_A]);
		assert.equal(b.named.size, 1);
		assert.equal(again.focused, 1);
		assert.equal(b.calls.length, 1, 'the held window is focused, not looked up by name again');
	});

	it('another address navigates the same window, focused, opener still null', () => {
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const first = open(URL_A) as unknown as Fake;
		const second = open(URL_B) as unknown as Fake;
		assert.equal(second, first);
		assert.equal(second.opener, null);
		assert.deepEqual(first.navigations, [URL_A, URL_B]);
		assert.equal(b.named.size, 1);
	});

	it('a featured open that answers a closed window falls back to the plain open', () => {
		b = makeBrowser(['closed', 'window']);
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const win = open(URL_A) as unknown as Fake;
		assert.ok(win && !win.closed);
		assert.equal(win.opener, null);
		assert.deepEqual(win.navigations, [URL_A]);
		assert.deepEqual(b.calls.map((c) => c.features), [FEATURES, undefined]);
	});

	it('a featured open that answers null falls back to the plain open too', () => {
		b = makeBrowser(['blocked', 'window']);
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const win = open(URL_A) as unknown as Fake;
		assert.ok(win);
		assert.deepEqual(b.calls.map((c) => c.features), [FEATURES, undefined]);
	});

	it('both opens blocked or closed: null, and the next try starts fresh', () => {
		b = makeBrowser(['closed', 'blocked', 'window']);
		const open = createCallWindowOpener(b.host, () => FEATURES);
		assert.equal(open(URL_A), null);
		const win = open(URL_A) as unknown as Fake;
		assert.ok(win);
		assert.deepEqual(win.navigations, [URL_A]);
	});

	it('a window the user closed is opened again, not focused', () => {
		const open = createCallWindowOpener(b.host, () => FEATURES);
		const first = open(URL_A) as unknown as Fake;
		first.closed = true;
		const second = open(URL_A) as unknown as Fake;
		assert.notEqual(second, first);
		assert.equal(second.opener, null);
		assert.deepEqual(second.navigations, [URL_A]);
	});
});
