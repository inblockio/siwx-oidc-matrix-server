// M10 W1 (D41 wire): what the kit does with the outcome of Element's Directory, and the two bundler swaps that wire it.
// Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';
import { runDirectory } from '../src/directory-flow.ts';

const harness = (known: string[] = []) => {
	const b = fixtureBridge();
	const calls: string[] = [];
	const deps = {
		directory: (o: Parameters<typeof b.openDirectory>[0]) => b.openDirectory(o),
		roomKnown: (rid: string) => known.includes(rid),
		openRoom: (rid: string) => void calls.push(`room:${rid}`),
		openPreview: (rid: string) => void calls.push(`preview:${rid}`),
		fail: (e: unknown) => void calls.push(`fail:${(e as Error).message}`),
	};
	return { b, calls, deps };
};

describe('runDirectory', () => {
	it('asks Element\'s Directory for rooms, and opens the picked (joined) room', async () => {
		const { b, calls, deps } = harness();
		await runDirectory(deps);
		assert.deepEqual(b.directoryCalls, [{ filter: 'rooms' }]);
		assert.deepEqual(calls, ['room:!directory:example.org']);
	});

	it('passes options given by a caller on (the search of K2 reuses it)', async () => {
		const { b, deps } = harness();
		await runDirectory(deps, { term: 'ops', filter: 'rooms' });
		assert.deepEqual(b.directoryCalls, [{ term: 'ops', filter: 'rooms' }]);
	});

	it('a peeked room (not joined) opens the not-joined screen, a peeked room the kit already has opens as a room', async () => {
		const { b, calls, deps } = harness();
		b.roomResult.openDirectory = { roomId: '!peek:example.org', peek: true };
		await runDirectory(deps);
		assert.deepEqual(calls, ['preview:!peek:example.org']);
		const known = harness(['!peek:example.org']);
		known.b.roomResult.openDirectory = { roomId: '!peek:example.org', peek: true };
		await runDirectory(known.deps);
		assert.deepEqual(known.calls, ['room:!peek:example.org']);
	});

	it('a closed Directory does nothing; a failure is the error path and opens nothing', async () => {
		const { b, calls, deps } = harness();
		b.roomResult.openDirectory = { status: 'cancelled' };
		await runDirectory(deps);
		assert.deepEqual(calls, []);
		b.roomResult.openDirectory = Object.assign(new Error('Element could not join the room'), { code: 'failed' });
		await runDirectory(deps);
		assert.deepEqual(calls, ['fail:Element could not join the room']);
	});
});

describe('webpack swaps of the Directory (D41 wire)', () => {
	const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
	const swaps = [...webpack.matchAll(/replaceFile\(\/(.+?)\/,\s*src\('([^']+)'\)\)/g)].map((m) => ({ re: new RegExp(m[1]), file: m[2] }));
	const rows: [string, string][] = [
		['apps/meteor/client/navbar/NavBarPagesGroup/NavBarItemDirectoryPage.tsx', 'directory-button.tsx'],
		['apps/meteor/client/navbar/NavBarPagesGroup/NavBarPagesStackMenu.tsx', 'pages-stack-menu.tsx'],
	];
	it('swaps the Directory button and the Pages stack menu, each by its own file', () => {
		for (const [path, file] of rows) {
			assert.equal(swaps.filter((s) => s.re.test(path) && s.file === file).length, 1, `${path} -> ${file}`);
			assert.equal(existsSync(new URL(`../src/${file}`, import.meta.url)), true, file);
		}
	});
});
