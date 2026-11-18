// tools/lib/viewactions-diff.mjs (D22 bump listing): the member parser reads members behind block comments and arrow-typed
// parameters, and a git failure is an error, never a clean zero (grok track F3, F4).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { diffLines, interfaces, stripComments } from '../../../tools/lib/viewactions-diff.mjs';

const FIXTURE = `
/** The action bar. { not a brace of the interface } */
export interface ActionBarViewActions {
	/** Starts a reply. (an unbalanced paren in prose */
	onReplyClick: (anchor: HTMLElement | null) => void;
	/**
	 * Edit: a doc block with an arrow => and a generic Promise<void>.
	 */
	onEditClick?: (anchor: HTMLElement | null) => void; // trailing comment with }
	/* plain block comment */ onPinClick: (anchor: HTMLElement | null) => Promise<void>;
	onFilter: (predicate: (item: Map<string, number>) => boolean, opts?: { deep: boolean }) => Array<Map<string, number>>;
	readonly label: string;
	onPlain(a: string): void;
}

export interface OtherViewActions { go: () => void }
export interface NotActions { skipped: () => void }
`;

describe('viewactions-diff parser', () => {
	it('strips line and block comments but keeps string literals', () => {
		assert.equal(stripComments('a /* x { */ b // y }\nc "//kept" d').replace(/\s+/g, ' '), 'a b c "//kept" d');
	});

	it('finds every member of a *ViewActions interface behind block comments and arrow-typed parameters', () => {
		const found = interfaces(FIXTURE);
		assert.deepEqual([...found.keys()], ['ActionBarViewActions', 'OtherViewActions']);
		assert.deepEqual(
			[...found.get('ActionBarViewActions')!.keys()],
			['onReplyClick', 'onEditClick', 'onPinClick', 'onFilter', 'label', 'onPlain'],
		);
		// The signature keeps its arrow and its nested parameter list in one member.
		assert.match(
			found.get('ActionBarViewActions')!.get('onFilter')!,
			/^onFilter: \(predicate: \(item: Map<string, number>\) => boolean, opts\?: \{ deep: boolean \}\) => Array<Map<string, number>>$/,
		);
		assert.deepEqual([...found.get('OtherViewActions')!.keys()], ['go']);
	});

	it('lists added interfaces and changed members from two sources', () => {
		const next = FIXTURE.replace('onPlain(a: string): void;', 'onPlain(a: number): void;\n\tonRemoveClick: () => void;').replace('onPinClick', 'onPin');
		const sources: Record<string, string> = { old: FIXTURE, new: next + '\nexport interface FreshViewActions { a(): void; b(): void }\n' };
		const lines = diffLines(['f.ts'], (ref: string) => sources[ref], 'old', 'new');
		assert.deepEqual(lines, [
			'changed ActionBarViewActions (f.ts): +onPin +onRemoveClick -onPinClick ~onPlain',
			'added FreshViewActions (f.ts): a, b',
		]);
	});
});

describe('viewactions-diff command', () => {
	const run = (...args: string[]) => spawnSync('node', ['tools/lib/viewactions-diff.mjs', ...args], { encoding: 'utf8' });
	const repo = mkdtempSync(join(tmpdir(), 'viewactions-'));
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	mkdirSync(join(repo, 'packages/shared-components/src'), { recursive: true });
	writeFileSync(join(repo, 'packages/shared-components/src/a.ts'), 'export interface AViewActions { x: () => void }\n');
	git('add', '.');
	git('commit', '-q', '-m', 'one');
	writeFileSync(join(repo, 'packages/shared-components/src/a.ts'), '/** doc */\nexport interface AViewActions { x: () => void; /** y */ y: (cb: () => void) => void }\n');
	git('commit', '-q', '-am', 'two');

	it('prints the changed members between two refs', () => {
		const r = run(repo, 'HEAD~1', 'HEAD');
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), 'changed AViewActions (packages/shared-components/src/a.ts): +y');
	});

	it('fails non-zero for a ref git does not know, instead of printing a clean zero', () => {
		const r = run(repo, 'HEAD~1', 'no-such-ref');
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.match(r.stderr, /no-such-ref/);
		assert.equal(run(repo, 'HEAD~1').status, 2);
		assert.equal(run('/no/such/repo', 'a', 'b').status, 1);
	});

	it('removes its scratch repo', () => {
		rmSync(repo, { recursive: true, force: true });
	});
});
