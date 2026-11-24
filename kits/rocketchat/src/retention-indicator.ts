// Room retention indicator (owner's ruling 2026-11-24): a room whose messages are deleted automatically shows a clock
// before its name in the sidebar and a line in the room header. The host decides (ViewRoom.retention, only while Element's
// io.inblock.room_retention key is set and the room has a max_lifetime) and words it; the kit only carries and draws it.
// Pure, no Rocket.Chat runtime, so node:test runs it.
import type { ViewRoom } from './bridge-types.ts';

/**
 * The field the kit adds to the room and the subscription documents. Not Rocket.Chat's own `retention` (its pruning
 * policy, which would switch on Rocket.Chat's retention warning and settings).
 */
export const RETENTION_INDICATOR_FIELD = 'retentionIndicator';

/** What the kit draws: the host's texts, already translated. */
export type RetentionIndicator = {
	/** The sidebar clock's accessible label and tooltip, "Messages are deleted after 2 weeks". */
	listLabel: string;
	/** The header line, visible without hovering, "Messages here are deleted after 2 weeks". */
	headerText: string;
};

/** The fields to spread into a room or subscription document: none for a room without clean-up (or an older host). */
export const retentionIndicatorFields = (r: ViewRoom): { retentionIndicator?: RetentionIndicator } => {
	const t = r.retention;
	if (!t || typeof t.listLabel !== 'string' || !t.listLabel || typeof t.headerText !== 'string' || !t.headerText) return {};
	return { [RETENTION_INDICATOR_FIELD]: { listLabel: t.listLabel, headerText: t.headerText } };
};

/** The indicator a room or subscription document carries, or undefined. Accepts any value (Rocket.Chat's own records). */
export const retentionIndicatorOf = (doc: unknown): RetentionIndicator | undefined => {
	if (typeof doc !== 'object' || doc === null) return undefined;
	const v = (doc as Record<string, unknown>)[RETENTION_INDICATOR_FIELD];
	if (typeof v !== 'object' || v === null) return undefined;
	const { listLabel, headerText } = v as Record<string, unknown>;
	if (typeof listLabel !== 'string' || !listLabel || typeof headerText !== 'string' || !headerText) return undefined;
	return { listLabel, headerText };
};
