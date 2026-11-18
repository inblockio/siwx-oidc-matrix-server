// Pure part of the quote click (M9 Q1): a click that ends a drag-select is not a jump.
/** A drag is a press that moved more than this many px before its release (then the click is the end of a drag-select). */
export const DRAG_PX = 4;

/** True when a click ends a drag-select (the press moved), or is part of a double/triple click (word/line select). */
export const endsSelection = (down: { x: number; y: number } | null, click: { x: number; y: number; detail: number }): boolean =>
	click.detail > 1 || (down !== null && Math.hypot(click.x - down.x, click.y - down.y) > DRAG_PX);
