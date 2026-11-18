// Bundler swap of Rocket.Chat's `client/lib/AudioEncoder.ts` (reason class "recorder asset"): the same encoder, with the worker
// bundled by the kit (`mp3-encoder-worker.ts`) instead of fetched from `<origin>/workers/mp3-encoder/index.js`, a Meteor
// public path that Element's server does not have. Without it the audio recorder never produces a file.
import { Emitter } from '@rocket.chat/emitter';

export class AudioEncoder extends Emitter {
	private worker: Worker;

	private scriptNode: ScriptProcessorNode;

	constructor(source: MediaStreamAudioSourceNode, { bufferLen = 4096, numChannels = 1, bitRate = 32 } = {}) {
		super();

		this.worker = new Worker(new URL('./mp3-encoder-worker.ts', import.meta.url));
		this.worker.onmessage = this.handleWorkerMessage;

		this.worker.postMessage({
			command: 'init',
			config: {
				sampleRate: source.context.sampleRate,
				numChannels,
				bitRate,
			},
		});

		this.scriptNode = source.context.createScriptProcessor(bufferLen, numChannels, numChannels);
		this.scriptNode.onaudioprocess = this.handleAudioProcess;

		source.connect(this.scriptNode);
		this.scriptNode.connect(source.context.destination);
	}

	close() {
		this.worker.postMessage({ command: 'finish' });
	}

	handleWorkerMessage = (message: MessageEvent) => {
		switch (message.data.command) {
			case 'end': {
				// prepend mp3 magic number to the buffer
				const magicNoPrefix = new Int8Array([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
				const bufferWithMagicNo = [magicNoPrefix, ...message.data.buffer];
				const blob = new Blob(bufferWithMagicNo, { type: 'audio/mpeg' });
				this.emit('encoded', blob);
				this.worker.terminate();
				break;
			}
		}
	};

	handleAudioProcess = (event: AudioProcessingEvent) => {
		for (let channel = 0; channel < event.inputBuffer.numberOfChannels; channel++) {
			const buffer = event.inputBuffer.getChannelData(channel);
			this.worker.postMessage({
				command: 'encode',
				buffer,
			});
		}
	};
}
