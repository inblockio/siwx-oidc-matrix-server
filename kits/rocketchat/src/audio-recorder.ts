// Bundler swap of Rocket.Chat's `client/lib/AudioRecorder.ts` (reason class "recorder fix", B6, grok F1): a microphone that
// arrives after Cancel or Finish (the permission prompt was still open, a slow device) is stopped at once, and such a start
// never settles (grok F3), so the composer neither begins a recording-activity renewal and timer that Cancel already ran past
// nor, on its error path, switches off the recording mode of a newer recorder. Unchanged:
// everything else. Rocket.Chat's version leaves that late stream live, with the browser's capture indicator on.
import { AudioEncoder } from 'rc/client/lib/AudioEncoder';
import { settings } from 'rc/client/lib/settings';

export class AudioRecorder {
	private audioContext: AudioContext | undefined;

	private stream: MediaStream | undefined;

	private encoder: AudioEncoder | undefined;

	// Counts start() and stop() calls: a start that is not the latest call when its stream arrives was stopped meanwhile.
	private session = 0;

	isSupported() {
		return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(AudioContext);
	}

	createAudioContext() {
		if (this.audioContext) {
			return;
		}

		this.audioContext = new AudioContext();
	}

	destroyAudioContext() {
		if (!this.audioContext) {
			return;
		}

		void this.audioContext.close();
		delete this.audioContext;
	}

	async createStream(session: number) {
		if (this.stream) {
			return;
		}

		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		if (session !== this.session) {
			stream.getTracks().forEach((track) => track.stop());
			return;
		}
		this.stream = stream;
	}

	destroyStream() {
		if (!this.stream) {
			return;
		}

		this.stream.getAudioTracks().forEach((track) => track.stop());
		delete this.stream;
	}

	async createEncoder() {
		if (this.encoder || !this.audioContext || !this.stream) {
			return;
		}

		const input = this.audioContext?.createMediaStreamSource(this.stream);
		this.encoder = new AudioEncoder(input, { bitRate: settings.peek('Message_Audio_bitRate') || 32 });
	}

	destroyEncoder() {
		if (!this.encoder) {
			return;
		}

		this.encoder.close();
		delete this.encoder;
	}

	async start(cb?: (this: this, done: boolean) => void) {
		const session = ++this.session;
		try {
			this.createAudioContext();
			await this.createStream(session);
			if (session !== this.session) {
				// Stopped while the microphone was being acquired: its late stream is already released.
				return this.cancelled(cb);
			}
			await this.createEncoder();
			cb?.call(this, true);
		} catch (error) {
			if (session !== this.session) {
				// A later start or stop owns the recorder's resources now; only report this one as not started.
				return this.cancelled(cb);
			}
			console.error(error);
			this.destroyEncoder();
			this.destroyStream();
			this.destroyAudioContext();
			cb?.call(this, false);
			throw error;
		}
	}

	// A start that was stopped meanwhile: reports "not started" and stays pending, as Rocket.Chat's own stop() does for a
	// recorder that has no encoder yet. Rejecting would run the composer's error path against whatever recorder is open now.
	private cancelled(cb?: (this: this, done: boolean) => void): Promise<void> {
		cb?.call(this, false);
		return new Promise<void>(() => undefined);
	}

	stop(cb: (data: Blob) => void) {
		this.session++;
		this.encoder?.on('encoded', cb);
		this.encoder?.close();

		this.destroyEncoder();
		this.destroyStream();
		this.destroyAudioContext();
	}
}
