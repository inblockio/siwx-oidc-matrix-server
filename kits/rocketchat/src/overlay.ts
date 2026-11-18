// N/A overlay (H4): every element of an N/A row in CAPABILITIES.md gets aria-disabled + inert, and a visible "N/A"
// badge in a body-level layer outside React's tree, so Rocket.Chat's renders never remove or fight it.
// eslint-disable-next-line import/no-unresolved
import table from '../CAPABILITIES.md';
import { parseCapabilities, type Capability } from './capabilities.ts';

export const LAYER_ID = 'kit-na-layer';

const mark = (el: Element, row: Capability) => {
	if (el.getAttribute('data-kit-na') === row.id) return;
	el.setAttribute('data-kit-na', row.id);
	el.setAttribute('aria-disabled', 'true');
	el.setAttribute('aria-description', `Not available in this view: ${row.reason}`);
	el.setAttribute('inert', '');
};

const badge = (doc: Document, el: Element, row: Capability) => {
	const rect = el.getBoundingClientRect();
	const node = doc.createElement('span');
	node.textContent = 'N/A';
	node.title = row.reason;
	node.setAttribute('data-kit-na-badge', row.id);
	node.setAttribute('aria-hidden', 'true');
	Object.assign(node.style, {
		position: 'fixed',
		top: `${Math.max(0, rect.top)}px`,
		left: `${Math.max(0, rect.right - 34)}px`,
		padding: '1px 4px',
		font: '600 10px/14px sans-serif',
		color: '#fff',
		background: '#6c727a',
		borderRadius: '3px',
	});
	return node;
};

export const startOverlay = (doc: Document = document, rows: Capability[] = parseCapabilities(table)) => {
	const naRows = rows.filter((row) => row.status === 'N/A');
	const layer = doc.createElement('div');
	layer.id = LAYER_ID;
	Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
	let queued = false;
	const apply = () => {
		queued = false;
		const badges: HTMLElement[] = [];
		for (const row of naRows) {
			for (const el of doc.querySelectorAll(row.selector)) {
				mark(el, row);
				if (el.getClientRects().length) badges.push(badge(doc, el, row));
			}
		}
		layer.replaceChildren(...badges);
	};
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(apply);
	};
	const mount = () => {
		doc.body.appendChild(layer);
		new MutationObserver((records) => {
			if (records.some((record) => !layer.contains(record.target))) schedule();
		}).observe(doc.body, { childList: true, subtree: true });
		addEventListener('resize', schedule);
		addEventListener('scroll', schedule, true);
		schedule();
	};
	if (doc.body) mount();
	else doc.addEventListener('DOMContentLoaded', mount, { once: true });
};
