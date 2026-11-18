// The stub-call log (H5): every call the adapter does not answer is rejected AND recorded, never faked as a success.
export type StubCall = { kind: string; name: string; at: number };

declare global {
	interface Window {
		__clientViewStubLog?: StubCall[];
		__clientViewAnswered?: string[];
	}
}

const g = globalThis as { __clientViewStubLog?: StubCall[]; __clientViewAnswered?: string[] };

/** Unanswered calls, in order. Also on `window.__clientViewStubLog` for specs and the capability map. */
export const stubLog: StubCall[] = (g.__clientViewStubLog ??= []);
/** Answered calls (mapped endpoints, methods, streams), for evidence. */
export const answeredLog: string[] = (g.__clientViewAnswered ??= []);

export const naError = (kind: string, name: string): Error => {
	stubLog.push({ kind, name, at: Date.now() });
	console.warn(`[client-view] N/A ${kind} ${name}`);
	return new Error(`N/A: ${kind} ${name} is not wired in this view`);
};

export const answered = (name: string): void => {
	answeredLog.push(name);
};
