// E0 F2: two own reactions reported in one synchronous pass both reach Rocket.Chat's `addRecentEmoji`, whose closure
// computes from closed-over state (EmojiPickerProvider `addFrequentEmojis`): through one closure only the last survives.
// The queue hands over one name per render. Run: node --test kits/rocketchat/test/ (needs the Rocket.Chat checkout, RC_ROOT).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const RC = process.env.RC_ROOT || join(process.env.HOME ?? '', '.cache/element-views-track/rocket.chat');
const have = existsSync(join(RC, 'node_modules/react-dom/package.json')) && existsSync(join(RC, 'node_modules/jsdom/package.json'));

describe('recent emoji queue', { skip: !have }, async () => {
	if (!have) return;
	register(
		'data:text/javascript,' +
			encodeURIComponent(`
export async function resolve(spec, ctx, next) {
	if (spec === 'react') return next(${JSON.stringify(RC)} + '/node_modules/react/index.js', ctx);
	return next(spec, ctx);
}`),
		import.meta.url,
	);
	const req = createRequire(join(RC, 'package.json'));
	const { JSDOM } = req('jsdom');
	const dom = new JSDOM('<!doctype html><div id="root"></div>');
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	const React = req('react');
	const { act } = req('react-dom/test-utils');
	const { createRoot } = req('react-dom/client');
	const { useRecentEmojiQueue } = await import('../src/recent-emoji-queue.ts');

	/** A provider like Rocket.Chat's: `add` recomputes the list from the state its closure closed over. */
	const mount = (reported: string[][]) => {
		let listener: ((n: string) => void) | undefined;
		const subscribe = (cb: (n: string) => void) => {
			listener = cb;
			return () => (listener = undefined);
		};
		let shown: string[] = [];
		const Provider = () => {
			const [list, setList] = React.useState([] as string[]);
			shown = list;
			const add = React.useCallback((name: string) => setList([name, ...list.filter((n) => n !== name)]), [list]);
			useRecentEmojiQueue(add, subscribe);
			return null;
		};
		const root = createRoot(dom.window.document.getElementById('root'));
		act(() => root.render(React.createElement(Provider)));
		return {
			report: (names: string[]) => act(() => names.forEach((n) => listener!(n))),
			list: () => shown,
			unmount: () => act(() => root.unmount()),
		};
	};

	it('two reactions reported in one pass are both recorded, newest first', () => {
		const p = mount([]);
		p.report(['tada', 'heart']);
		assert.deepEqual(p.list(), ['heart', 'tada']);
		p.unmount();
	});

	it('one reaction, then another later, and the same emoji twice (no duplicate)', () => {
		const p = mount([]);
		p.report(['tada']);
		p.report(['heart', 'tada']);
		assert.deepEqual(p.list(), ['tada', 'heart']);
		p.unmount();
	});

	it('without the queue the shared closure loses all but the last name (what the queue fixes)', () => {
		let shown: string[] = [];
		const Direct = () => {
			const [list, setList] = React.useState([] as string[]);
			shown = list;
			const add = (name: string) => setList([name, ...list]);
			React.useEffect(() => {
				add('tada');
				add('heart');
			}, []);
			return null;
		};
		const root = createRoot(dom.window.document.getElementById('root'));
		act(() => root.render(React.createElement(Direct)));
		assert.deepEqual(shown, ['heart']);
		act(() => root.unmount());
	});
});
