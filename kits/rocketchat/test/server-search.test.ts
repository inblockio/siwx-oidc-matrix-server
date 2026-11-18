// M10 W5 (D41 wire): the sidebar search hands its term to Element's own Spotlight. Expected values are the task's
// (card "Kit side": two options "Public rooms matching <term>" and "People matching <term>", each openDirectory({ term, filter })).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';
import { BridgeSource } from '../src/adapter/source.ts';
import { runDirectory } from '../src/directory-flow.ts';
import { activatesOption, searchHandOff, serverSearchAttributes, serverSearchOptions, serverSearchTerm } from '../src/server-search.ts';

const harness = () => {
	const b = fixtureBridge();
	const calls: string[] = [];
	const deps = {
		directory: (o: Parameters<typeof b.openDirectory>[0]) => b.openDirectory(o),
		roomKnown: () => false,
		openRoom: (rid: string) => void calls.push(`room:${rid}`),
		openPreview: (rid: string) => void calls.push(`preview:${rid}`),
		fail: (e: unknown) => void calls.push(`fail:${(e as Error).message}`),
	};
	return { b, calls, deps };
};

describe('the options of the sidebar search (W5)', () => {
	it('a typed term lists "Public rooms matching" then "People matching", each with its filter', () => {
		assert.deepEqual(serverSearchOptions('ops', true), [
			{ filter: 'rooms', term: 'ops', label: 'Public rooms matching ops' },
			{ filter: 'people', term: 'ops', label: 'People matching ops' },
		]);
	});

	it('no term (empty, blank, only a prefix) lists nothing; Rocket.Chat\'s @ and # prefix and the blanks are not part of the term', () => {
		for (const text of [undefined, '', '   ', '@', '#', ' # ']) assert.deepEqual(serverSearchOptions(text, true), [], JSON.stringify(text));
		assert.equal(serverSearchTerm('#lobby:example.org'), 'lobby:example.org');
		assert.equal(serverSearchTerm('@ bob '), 'bob');
		assert.equal(serverSearchTerm(' two words '), 'two words');
	});

	it('a host without openDirectory (an older bridge) is offered no option', () => {
		assert.deepEqual(serverSearchOptions('ops', false), []);
		const b = fixtureBridge();
		assert.equal(new BridgeSource(b).canOpenDirectory(), true);
		delete (b as { openDirectory?: unknown }).openDirectory;
		assert.equal(new BridgeSource(b).canOpenDirectory(), false);
	});

	it('the options are keyboard-reachable (role option, focusable) and carry the row\'s selector attribute; Enter and Space activate', () => {
		const [rooms, people] = serverSearchOptions('ops', true);
		assert.deepEqual(serverSearchAttributes(rooms), { role: 'option', tabIndex: 0, 'data-kit-server-search': 'rooms' });
		assert.equal(serverSearchAttributes(people)['data-kit-server-search'], 'people');
		assert.deepEqual(['Enter', ' ', 'a', 'Tab'].map(activatesOption), [true, true, false, false]);
	});
});

describe('the hand-off to Element\'s Spotlight (W5)', () => {
	it('each option asks openDirectory with its term and filter, and nothing else', async () => {
		const { b, deps } = harness();
		const [rooms, people] = serverSearchOptions('ops', true);
		await runDirectory(deps, searchHandOff(rooms));
		await runDirectory(deps, searchHandOff(people));
		assert.deepEqual(b.directoryCalls, [
			{ term: 'ops', filter: 'rooms' },
			{ term: 'ops', filter: 'people' },
		]);
	});

	it('a picked room or an opened person opens here; a closed Spotlight does nothing; a failure is the error path', async () => {
		const { b, calls, deps } = harness();
		const [rooms, people] = serverSearchOptions('bob', true);
		b.roomResult.openDirectory = { roomId: '!dm:example.org' };
		await runDirectory(deps, searchHandOff(people));
		assert.deepEqual(calls, ['room:!dm:example.org']);
		b.roomResult.openDirectory = { roomId: '!peek:example.org', peek: true };
		await runDirectory(deps, searchHandOff(rooms));
		assert.deepEqual(calls.slice(1), ['preview:!peek:example.org']);
		b.roomResult.openDirectory = { status: 'cancelled' };
		await runDirectory(deps, searchHandOff(people));
		b.roomResult.openDirectory = Object.assign(new Error('Element could not join the room'), { code: 'failed' });
		await runDirectory(deps, searchHandOff(rooms));
		assert.deepEqual(calls.slice(2), ['fail:Element could not join the room']);
	});
});

describe('webpack swap of the sidebar search listbox (D41 wire)', () => {
	it('swaps NavBarSearchListbox by the kit\'s copy', () => {
		const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
		const swaps = [...webpack.matchAll(/replaceFile\(\/(.+?)\/,\s*src\('([^']+)'\)\)/g)].map((m) => ({ re: new RegExp(m[1]), file: m[2] }));
		const path = 'apps/meteor/client/navbar/NavBarSearch/NavBarSearchListbox.tsx';
		assert.equal(swaps.filter((s) => s.re.test(path) && s.file === 'navbar-search-listbox.tsx').length, 1);
		assert.equal(existsSync(new URL('../src/navbar-search-listbox.tsx', import.meta.url)), true);
	});
});
