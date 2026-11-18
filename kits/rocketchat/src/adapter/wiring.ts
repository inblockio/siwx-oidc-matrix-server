// What bootstrap wires for the swapped SDK module. The bundler loads that module twice (the swap keeps the original
// request, so bootstrap's import of adapter/sdk.ts is a second copy of it): state held in sdk.ts itself would be set on
// one copy and read from the other. This module is imported with the same request from both, so it exists once.
export type CachedName = 'rooms' | 'subscriptions';
export type RestoreComposer = (rid: string, text: string) => boolean | void;
/** Whether the composer of `rid` that is on screen now holds `text` (the room is at the route and the textarea is mounted). */
export type ComposerHolds = (rid: string, text: string) => boolean;
/** Rocket.Chat's own per-room draft (it is the composer's initial value when the room's composer mounts). */
export type SaveDraft = (rid: string, text: string) => void;

export const wiring: { cachedIds: Partial<Record<CachedName, () => Iterable<string>>>; restoreComposer?: RestoreComposer; composerHolds?: ComposerHolds; saveDraft?: SaveDraft; openRoom?: (rid: string, replace?: boolean) => void; jumpFailed?: (message: string) => void; lookedUp: Map<string, string> } = {
	cachedIds: {},
	lookedUp: new Map(),
};
