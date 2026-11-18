// Bundler swap of Rocket.Chat's `client/lib/videoRecorder.ts` (reason class "recorder fix", B6, grok F2): `stop(cb)` hands the
// file over only after the MediaRecorder's last chunk has arrived (its `stop` event), and not at all when nothing was recorded
// (Send before Record). Rocket.Chat's version builds the Blob at once, before Chromium delivers the final `dataavailable`, and
// uploads an empty file for Send-before-Record. Each take owns its chunks (grok F1, F2): a cancelled, sent or superseded take
// can neither be uploaded by a later Send nor leak its late chunk into the next take. Sessions own the camera exclusively
// (grok R3): a start releases the camera, microphone and recorder of the session before it (the thread composer beside the
// room composer share this singleton), a stale getUserMedia result never reaches the live session, and a MediaRecorder that
// is already inactive or throws on stop() cannot keep the tracks live. A session has one owner (grok R4): start() returns the
// session, and record(), stopRecording() and stop() given a session that is no longer the live one do nothing, so a composer
// that was released cannot end, record or send the take of the composer that took over. The last chunk of a take is awaited
// whether stop() is called while it is recording or after (an active take is never handed over empty).
import { Emitter } from '@rocket.chat/emitter';
import { useCallback, useSyncExternalStore } from 'react';

type VideoRecorderEvents = {
	cameraStartedChange: boolean;
};

class VideoRecorder extends Emitter<VideoRecorderEvents> {
	private _cameraStarted = false;

	private started = false;

	private recordingAvailable = false;

	private videoel: HTMLVideoElement | undefined;

	// The current take: its chunks, and a promise that settles when its stopped MediaRecorder has delivered the last one.
	private take: { chunks: Blob[]; lastChunk: Promise<void> } | undefined;

	private stream: MediaStream | undefined;

	private mediaRecorder: MediaRecorder | undefined;

	private sessionId = 0;

	public get cameraStarted(): boolean {
		return this._cameraStarted;
	}

	private setCameraStarted(value: boolean) {
		if (this._cameraStarted === value) {
			return;
		}
		this._cameraStarted = value;
		this.emit('cameraStartedChange', value);
	}

	public getSupportedMimeTypes() {
		if (window.MediaRecorder.isTypeSupported('video/webm')) {
			return 'video/webm; codecs=vp8,opus';
		}
		if (window.MediaRecorder.isTypeSupported('video/mp4')) {
			return 'video/mp4';
		}
		return '';
	}

	// The session a call belongs to is the one start() returned; a call without one acts on the live session.
	private owns(session?: number): boolean {
		return session === undefined || session === this.sessionId;
	}

	public start(videoel?: HTMLVideoElement, cb?: (this: this, success: boolean, session: number) => void): number {
		const currentSessionId = ++this.sessionId;
		this.release(); // A session before this one (another composer, a StrictMode double start) must not keep the camera.
		delete this.take;
		this.videoel = videoel;

		const handleSuccess = (stream: MediaStream) => {
			if (this.isStaleSession(currentSessionId)) {
				this.stopStreamTracks(stream);
				return;
			}
			this.startUserMedia(stream);
			cb?.call(this, true, currentSessionId);
		};

		const handleError = (error: any) => {
			if (this.isStaleSession(currentSessionId)) {
				// Superseded or stopped meanwhile: the composer that asked has moved on, and a cancel here would end the live session.
				return;
			}
			console.error(error);
			cb?.call(this, false, currentSessionId);
		};

		if (navigator.mediaDevices) {
			navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(handleSuccess, handleError);
			return currentSessionId;
		}

		const oldGetUserMedia = navigator.getUserMedia ?? navigator.webkitGetUserMedia ?? navigator.mozGetUserMedia ?? navigator.msGetUserMedia;

		if (oldGetUserMedia) {
			oldGetUserMedia.call(navigator, { audio: true, video: true }, handleSuccess, handleError);
			return currentSessionId;
		}

		cb?.call(this, false, currentSessionId);
		return currentSessionId;
	}

	public record(session?: number) {
		if (!this.owns(session)) {
			return;
		}
		delete this.take;
		if (!this.stream) {
			return;
		}

		const take = { chunks: [] as Blob[], lastChunk: Promise.resolve() };
		this.take = take;
		this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.getSupportedMimeTypes() });
		this.mediaRecorder.ondataavailable = (blobev) => {
			take.chunks.push(blobev.data);
			if (!this.recordingAvailable) {
				this.recordingAvailable = true;
			}
		};
		this.mediaRecorder.start();
	}

	private stopStreamTracks(stream: MediaStream) {
		const vtracks = stream.getVideoTracks();
		for (const vtrack of Array.from(vtracks)) {
			vtrack.stop();
		}

		const atracks = stream.getAudioTracks();
		for (const atrack of Array.from(atracks)) {
			atrack.stop();
		}
	}

	private isStaleSession(sessionId: number): boolean {
		return this.sessionId !== sessionId;
	}

	private startUserMedia(stream: MediaStream) {
		if (!this.videoel) {
			this.stopStreamTracks(stream); // Nothing to show it in: do not leave the camera on.
			return;
		}
		this.stream = stream;

		try {
			this.videoel.srcObject = stream;
		} catch (error) {
			const URL = window.URL || window.webkitURL;
			this.videoel.src = URL.createObjectURL(stream as unknown as MediaSource | Blob);
		}

		this.started = true;
		this.setCameraStarted(true);
	}

	// Ends the current session's recorder, tracks and video element. Keeps `take` for the caller.
	private release() {
		this.endRecording();

		if (this.stream) {
			this.stopStreamTracks(this.stream);
		}

		if (this.videoel) {
			this.videoel.pause();
			this.videoel.src = '';
		}

		this.started = false;
		this.setCameraStarted(false);
		this.recordingAvailable = false;
		delete this.mediaRecorder;
		delete this.stream;
		delete this.videoel;
	}

	public stop(cb?: (blob: Blob) => void, session?: number) {
		if (!this.owns(session)) {
			return;
		}
		this.sessionId++;

		const wasStarted = this.started;
		const { take } = this;
		this.endRecording(); // Sets the take's last-chunk promise (on the take still in place) before the take is read below.
		delete this.take;
		this.release();

		if (cb && take && wasStarted) {
			const { chunks, lastChunk } = take;
			void lastChunk.then(() => {
				const blob = new Blob(chunks);
				if (blob.size > 0) cb(blob);
			});
		}
	}

	public stopRecording(session?: number) {
		if (this.owns(session)) {
			this.endRecording();
		}
	}

	private endRecording() {
		if (!this.started || !this.mediaRecorder) {
			return;
		}

		const recorder = this.mediaRecorder;
		delete this.mediaRecorder; // Whatever stop() does, this recorder is done: a second Stop, Cancel or Send must not meet it again.
		let settle: () => void = () => undefined;
		const lastChunk = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 5000); // A recorder that never reports back must not hold the file for ever.
			settle = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		if (this.take) {
			this.take.lastChunk = lastChunk;
		}
		if (recorder.state === 'inactive') {
			settle(); // Already stopped by itself (a track ended): its last chunk and stop event are past, stop() would throw.
			return;
		}
		recorder.addEventListener('stop', settle, { once: true });
		try {
			recorder.stop();
		} catch (error) {
			console.error(error);
			settle();
		}
	}
}

const instance = new VideoRecorder();

export { instance as VideoRecorder };

export const useVideoRecorderCameraStarted = (): boolean =>
	useSyncExternalStore(
		useCallback((onStoreChange) => instance.on('cameraStartedChange', onStoreChange), []),
		() => instance.cameraStarted,
	);
