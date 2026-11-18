import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DRAG_PX, endsSelection } from '../src/quote-click.ts';

describe('quote click', () => {
	it('a plain click jumps', () => {
		assert.equal(endsSelection({ x: 10, y: 10 }, { x: 10, y: 10, detail: 1 }), false);
		assert.equal(endsSelection({ x: 10, y: 10 }, { x: 10 + DRAG_PX, y: 10, detail: 1 }), false);
		assert.equal(endsSelection(null, { x: 10, y: 10, detail: 1 }), false);
	});
	it('the end of a drag-select does not', () => {
		assert.equal(endsSelection({ x: 10, y: 10 }, { x: 80, y: 12, detail: 1 }), true);
	});
	// The first click of a double click (detail 1) has already jumped; only the second (detail 2) is held back. Select by dragging.
	it('the second click of a double click does not jump again (the first one did: see the LIMIT on message-quote-jump)', () => {
		assert.equal(endsSelection({ x: 10, y: 10 }, { x: 10, y: 10, detail: 2 }), true);
	});
});
