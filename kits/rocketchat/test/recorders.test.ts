// B6 recorder swaps (audio-recorder.ts, video-recorder.ts) against fake media: a cancelled or stale session never uploads and
// never leaves a live track. Run: node --test kits/rocketchat/test/ (Node >= 22.18 strips the types). The two Rocket.Chat
// packages the swaps import (emitter, react) come from the Rocket.Chat checkout (RC_ROOT); without it the file is skipped.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const RC = process.env.RC_ROOT || join(process.env.HOME ?? '', '.cache/element-views-track/rocket.chat');
const have = existsSync(join(RC, 'node_modules/@rocket.chat/emitter/package.json'));

class FakeTrack {
	readyState = 'live';
	stop() {
		this.readyState = 'ended';
	}
}
class FakeStream {
	tracks = [new FakeTrack(), new FakeTrack()];
	getTracks() {
		return this.tracks;
	}
	getAudioTracks() {
		return [this.tracks[0]];
	}
	getVideoTracks() {
		return [this.tracks[1]];
	}
	get live() {
		return this.tracks.filter((t) => t.readyState === 'live').length;
	}
}
// A MediaRecorder whose last chunk is delivered by the test, as Chromium does after stop().
class FakeRecorder {
	static all: FakeRecorder[] = [];
	static isTypeSupported = () => true;
	ondataavailable: ((ev: { data: Blob }) => void) | null = null;
	listeners: Array<() => void> = [];
	state = 'inactive';
	stopCalls = 0;
	constructor() {
		FakeRecorder.all.push(this);
	}
	start() {
		this.state = 'recording';
	}
	// As a real MediaRecorder: stop() on an inactive recorder throws InvalidStateError.
	stop() {
		this.stopCalls++;
		if (this.state === 'inactive') throw new Error('InvalidStateError: MediaRecorder is not recording');
		this.state = 'inactive';
	}
	addEventListener(_type: string, fn: () => void) {
		this.listeners.push(fn);
	}
	deliver(text: string) {
		this.ondataavailable?.({ data: new Blob([text]) });
		this.listeners.forEach((fn) => fn());
	}
}

const gum: { pending: Array<() => void>; rejects: Array<(e: Error) => void>; streams: FakeStream[]; delayed: boolean } = {
	pending: [],
	rejects: [],
	streams: [],
	delayed: false,
};
const setup = () => {
	FakeRecorder.all = [];
	gum.pending = [];
	gum.rejects = [];
	gum.streams = [];
	gum.delayed = false;
	const g = globalThis as any;
	const win: any = { MediaRecorder: FakeRecorder, URL: { createObjectURL: () => 'blob:x' } };
	g.window = win;
	g.MediaRecorder = FakeRecorder;
	g.AudioContext = class {
		createMediaStreamSource() {
			return {};
		}
		close() {
			return Promise.resolve();
		}
	};
	Object.defineProperty(g, 'navigator', {
		configurable: true,
		value: {
			mediaDevices: {
				getUserMedia: () =>
					new Promise<FakeStream>((resolve, reject) => {
						const s = new FakeStream();
						gum.streams.push(s);
						gum.rejects.push(reject);
						if (gum.delayed) gum.pending.push(() => resolve(s));
						else resolve(s);
					}),
			},
		},
	});
};
const video = () => ({ pause() {}, src: '', srcObject: null }) as unknown as HTMLVideoElement;
const text = (b: Blob) => b.text();
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('recorder swaps', { skip: !have }, async () => {
	if (!have) return;
	register(
		'data:text/javascript,' +
			encodeURIComponent(`
const RC = ${JSON.stringify(RC)};
export async function resolve(spec, ctx, next) {
	if (spec === '@rocket.chat/emitter' || spec === 'react') return next(RC + '/node_modules/' + spec + '/' + (spec === 'react' ? 'index.js' : 'dist/index.js'), ctx);
	if (spec === 'rc/client/lib/AudioEncoder') return { url: 'data:text/javascript,' + encodeURIComponent("export class AudioEncoder { constructor(){ this.l={}; } on(e,f){ this.l[e]=f; } close(){ this.l.encoded&&this.l.encoded(new Blob(['mp3'])); } }"), shortCircuit: true };
	if (spec === 'rc/client/lib/settings') return { url: 'data:text/javascript,' + encodeURIComponent('export const settings = { peek: () => 32 }'), shortCircuit: true };
	return next(spec, ctx);
}`),
		import.meta.url,
	);
	setup();
	const { VideoRecorder } = await import('../src/video-recorder.ts');
	const { AudioRecorder } = await import('../src/audio-recorder.ts');

	it('F1: Send in a new session without a new take uploads nothing (cancelled take)', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.stopRecording();
		VideoRecorder.stop(); // Cancel
		FakeRecorder.all[0].deliver('take-1'); // the late last chunk of the cancelled take
		await tick();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		let sent = 0;
		VideoRecorder.stop(() => sent++); // Send without Record
		await tick();
		assert.equal(sent, 0);
	});

	it('F1: Send in a new session without a new take uploads nothing (take already sent)', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.stopRecording();
		let first = '';
		VideoRecorder.stop(async (b) => void (first = await text(b)));
		FakeRecorder.all[0].deliver('take-1');
		await tick();
		assert.equal(first, 'take-1');
		VideoRecorder.start(video(), () => undefined);
		await tick();
		let sent = 0;
		VideoRecorder.stop(() => sent++);
		await tick();
		assert.equal(sent, 0);
	});

	it('F2: Record again before the last chunk of the stopped take lands keeps the takes apart', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.stopRecording(); // Stop
		VideoRecorder.record(); // Record again before take 1's chunk
		FakeRecorder.all[0].deliver('take-1');
		VideoRecorder.stopRecording();
		let got = '';
		VideoRecorder.stop(async (b) => void (got = await text(b)));
		FakeRecorder.all[1].deliver('take-2');
		await tick();
		assert.equal(got, 'take-2');
	});

	it('video: a normal take is delivered whole after the last chunk', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.stopRecording();
		let got = '';
		VideoRecorder.stop(async (b) => void (got = await text(b)));
		FakeRecorder.all[0].deliver('whole');
		await tick();
		assert.equal(got, 'whole');
	});

	it('F3: a start cancelled while the microphone is pending never settles (no timers begin) and releases the microphone', async () => {
		setup();
		gum.delayed = true;
		const rec = new AudioRecorder();
		let cbDone: boolean | undefined;
		let settled = 'pending';
		rec.start((done) => (cbDone = done)).then(
			() => (settled = 'resolved'),
			() => (settled = 'rejected'),
		);
		rec.stop(() => undefined); // Cancel while getUserMedia is pending
		gum.pending[0]();
		await tick();
		assert.equal(settled, 'pending');
		assert.equal(cbDone, false);
		assert.equal(gum.streams[0].tracks[0].readyState, 'ended');
	});

	it('F3: a stale start does not tear down the recorder a newer start owns', async () => {
		setup();
		gum.delayed = true;
		const rec = new AudioRecorder();
		const first = rec.start();
		rec.stop(() => undefined);
		gum.delayed = false;
		await rec.start(); // the newer start
		gum.pending[0]();
		void first;
		await tick();
		let got = '';
		rec.stop(async (b) => void (got = await text(b)));
		await tick();
		assert.equal(got, 'mp3');
		assert.equal(gum.streams[0].tracks[0].readyState, 'ended');
	});

	it('audio: a normal start still resolves and stop hands the file over', async () => {
		setup();
		const rec = new AudioRecorder();
		await rec.start();
		let got = '';
		rec.stop(async (b) => void (got = await text(b)));
		await tick();
		assert.equal(got, 'mp3');
		assert.equal(gum.streams[0].tracks[0].readyState, 'ended');
	});

	// Fix round 3 (grok delta of round 2).
	it('R3 F1: a second start (thread composer beside the room composer) releases the first camera and microphone', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.stopRecording(); // a stopped, unsent take of the first composer
		VideoRecorder.start(video(), () => undefined); // the second composer, same singleton
		await tick();
		assert.equal(gum.streams[0].live, 0, 'first stream still live');
		assert.equal(gum.streams[1].live, 2);
		let sent = 0;
		VideoRecorder.stop(() => sent++);
		FakeRecorder.all[0].deliver('take-1'); // late chunk of the dropped take
		await tick();
		assert.equal(sent, 0, 'stale take uploaded');
		assert.equal(gum.streams[1].live, 0);
	});

	it('R3 F1: a second start while the first recorder runs stops that recorder', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		assert.equal(FakeRecorder.all[0].state, 'inactive');
		VideoRecorder.stop();
	});

	it('R3 F2: a late rejection of a superseded getUserMedia does not cancel the live session', async () => {
		setup();
		gum.delayed = true;
		const calls: boolean[] = [];
		const quiet = console.error;
		console.error = () => undefined;
		VideoRecorder.start(video(), (ok) => calls.push(ok)); // StrictMode: first start ...
		VideoRecorder.stop(); // ... cleanup ...
		VideoRecorder.start(video(), (ok) => calls.push(ok)); // ... second start
		gum.pending[1]();
		await tick();
		gum.rejects[0](new Error('NotAllowedError')); // the first request fails late
		await tick();
		console.error = quiet;
		assert.deepEqual(calls, [true], 'stale error reached the composer');
		assert.equal(gum.streams[1].live, 2, 'live session was touched');
		VideoRecorder.stop();
	});

	it('R3 F2: a late success of a superseded getUserMedia releases its stream and reports nothing', async () => {
		setup();
		gum.delayed = true;
		const calls: boolean[] = [];
		VideoRecorder.start(video(), (ok) => calls.push(ok));
		VideoRecorder.stop();
		VideoRecorder.start(video(), (ok) => calls.push(ok));
		gum.pending[1]();
		gum.pending[0]();
		await tick();
		assert.deepEqual(calls, [true]);
		assert.equal(gum.streams[0].live, 0);
		assert.equal(gum.streams[1].live, 2);
		VideoRecorder.stop();
	});

	it('R3 F2: a genuine error of the current start is still reported', async () => {
		setup();
		gum.delayed = true;
		const calls: boolean[] = [];
		const quiet = console.error;
		console.error = () => undefined;
		VideoRecorder.start(video(), (ok) => calls.push(ok));
		gum.rejects[0](new Error('NotAllowedError'));
		await tick();
		console.error = quiet;
		assert.deepEqual(calls, [false]);
	});

	it('R3 F3: Stop on a recorder that is already inactive does not throw, and the take is still sent', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		const rec = FakeRecorder.all[0];
		rec.deliver('early'); // the browser ended the recording by itself (a track ended)
		rec.state = 'inactive';
		assert.doesNotThrow(() => VideoRecorder.stopRecording());
		let got = '';
		VideoRecorder.stop(async (b) => void (got = await text(b)));
		await tick();
		assert.equal(got, 'early');
		assert.equal(gum.streams[0].live, 0);
	});

	it('R3 F3: a recorder whose stop() throws still lets Cancel release the camera and microphone', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record();
		FakeRecorder.all[0].stop = () => {
			throw new Error('InvalidStateError');
		};
		assert.doesNotThrow(() => VideoRecorder.stop());
		assert.equal(gum.streams[0].live, 0, 'camera still on after Cancel');
		assert.doesNotThrow(() => VideoRecorder.stop()); // and a second Cancel/Send does not throw again
	});

	it('R3 audio: a late rejection of a superseded microphone request does not reject into the newer recorder', async () => {
		setup();
		gum.delayed = true;
		const rec = new AudioRecorder();
		const quiet = console.error;
		console.error = () => undefined;
		let settled = 'pending';
		rec.start().then(
			() => (settled = 'resolved'),
			() => (settled = 'rejected'),
		);
		rec.stop(() => undefined);
		gum.delayed = false;
		await rec.start(); // the newer start owns the recorder
		gum.rejects[0](new Error('NotAllowedError'));
		await tick();
		console.error = quiet;
		assert.equal(settled, 'pending');
		let got = '';
		rec.stop(async (b) => void (got = await text(b)));
		await tick();
		assert.equal(got, 'mp3');
		assert.equal(gum.streams[1].tracks[0].readyState, 'ended');
	});
	it('R4 F1: Send from the owner while a take is recording hands the whole take over (not an empty file)', async () => {
		setup();
		VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record(); // the take is still recording, its last chunk has not arrived
		let got = '';
		VideoRecorder.stop(async (b) => void (got = await text(b)));
		await tick(); // Chromium delivers the last chunk some time after stop()
		assert.equal(got, '', 'handed over before the last chunk');
		FakeRecorder.all[0].deliver('whole-take');
		await tick();
		assert.equal(got, 'whole-take');
		assert.equal(gum.streams[0].live, 0);
	});

	it('R4 F2: the released composer Cancel does not end the session of the composer that took over', async () => {
		setup();
		const room = VideoRecorder.start(video(), () => undefined);
		await tick();
		const thread = VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.stop(undefined, room); // room dialog: Cancel, or its effect cleanup, after the thread took the camera
		assert.equal(gum.streams[1].live, 2, 'thread camera was stopped by the room composer');
		VideoRecorder.record(thread);
		assert.equal(FakeRecorder.all.length, 1, 'thread record() did not start after the room composer stopped');
		VideoRecorder.stop(undefined, thread);
		assert.equal(gum.streams[1].live, 0);
	});

	it('R4 F2: the released composer Send neither uploads the thread take into the room nor stops the thread', async () => {
		setup();
		const room = VideoRecorder.start(video(), () => undefined);
		await tick();
		const thread = VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record(thread);
		VideoRecorder.stopRecording(thread); // the thread has a stopped take
		let sent = 0;
		VideoRecorder.stop(() => sent++, room); // room Send
		FakeRecorder.all[0].deliver('thread-take');
		await tick();
		assert.equal(sent, 0, 'thread take uploaded through the room composer');
		assert.equal(gum.streams[1].live, 2, 'thread camera stopped by the room composer');
		let got = '';
		VideoRecorder.stop(async (b) => void (got = await text(b)), thread); // the thread Send still works
		await tick();
		assert.equal(got, 'thread-take');
	});

	it('R4 F2: the released composer Record and Stop-recording cannot drive the live session', async () => {
		setup();
		const room = VideoRecorder.start(video(), () => undefined);
		await tick();
		const thread = VideoRecorder.start(video(), () => undefined);
		await tick();
		VideoRecorder.record(room); // room Record on the thread MediaStream
		assert.equal(FakeRecorder.all.length, 0, 'room composer recorded the thread camera');
		VideoRecorder.record(thread);
		VideoRecorder.stopRecording(room);
		assert.equal(FakeRecorder.all[0].state, 'recording', 'room composer stopped the thread take');
		VideoRecorder.stop(undefined, thread);
	});

	it('R4: start reports the session to its callback, also for a failed start', async () => {
		setup();
		let seen: unknown;
		const token = VideoRecorder.start(video(), (_ok: boolean, session?: number) => void (seen = session));
		await tick();
		assert.equal(typeof token, 'number');
		assert.equal(seen, token);
		VideoRecorder.stop(undefined, token);
	});
});
