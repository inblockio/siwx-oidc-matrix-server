// M13 U2: a video Element hides takes the same kit path as a hidden image (M12 Z3): the adapter marks it with
// `kitHiddenMedia`, the swapped image attachment draws Rocket.Chat's own "Click to load" box, and the click is
// Element's reveal (`bridge.showMedia`, which accepts a video). No host change, no second swapped Rocket.Chat file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';

const bridge = fixtureBridge();
const win: Record<string, unknown> = {
	location: { pathname: '/kits/rocketchat/index.html', hash: '', origin: 'http://localhost', search: '' },
	history: {},
	localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
	__clientViewBridge: bridge,
};
win.parent = win;
Object.assign(globalThis, { window: win });

const { BridgeSource } = await import('../src/adapter/source.ts');
const { mediaAttachment } = await import('../src/adapter/map.ts');

const GENERAL = '!general:example.org';
type Att = Record<string, unknown> & { type: string; title: string; image_url?: string; video_url?: string; kitHiddenMedia?: { rid: string; eventId: string }; image_dimensions?: { width: number; height: number } };

describe('M13 U2: a hidden video is the Click to load box', () => {
	const hidden = { kind: 'video', state: 'hidden', name: 'clip.mp4', label: 'Show video', width: 640, height: 360 };
	const host = { rid: GENERAL, id: '$vid', canShowMedia: true };

	it('a hidden video on a host with showMedia carries the marker, no URL and no link (the same shape as a hidden image)', () => {
		const a = mediaAttachment(hidden as never, host) as unknown as Att;
		assert.equal(a.type, 'file');
		assert.equal(a.title, 'clip.mp4');
		assert.equal(a.image_url, '');
		assert.equal('video_url' in a || 'title_link' in a, false);
		assert.deepEqual(a.kitHiddenMedia, { rid: GENERAL, eventId: '$vid' });
		assert.deepEqual(a.image_dimensions, { width: 368, height: 207 }, "the player's footprint with the video's aspect");
		assert.equal((mediaAttachment({ ...hidden, name: '' } as never, host) as unknown as Att).title, 'Show video');
	});

	it("a tiny clip still gets a box that holds the Load text (a 16x16 box wrapped it and it overflowed over the composer)", () => {
		const a = mediaAttachment({ ...hidden, width: 16, height: 16 } as never, host) as unknown as Att;
		assert.deepEqual(a.image_dimensions, { width: 368, height: 368 });
		assert.equal('image_dimensions' in (mediaAttachment({ ...hidden, width: undefined, height: undefined } as never, host) as unknown as Att), false);
		// an image keeps its own size (Z3)
		const img = mediaAttachment({ ...hidden, kind: 'image', width: 320, height: 200 } as never, host) as unknown as Att;
		assert.deepEqual(img.image_dimensions, { width: 320, height: 200 });
	});

	it('without showMedia, or with a URL already, a hidden video stays the plain file-name row (no marker)', () => {
		for (const [media, message] of [
			[hidden, { ...host, canShowMedia: false }],
			[hidden, { rid: GENERAL, id: '$vid' }],
			[{ ...hidden, url: 'http://hs/x.mp4' }, host],
		] as const) {
			const a = mediaAttachment(media as never, message) as unknown as Att;
			assert.equal(a.type, 'file');
			assert.equal(a.title, 'clip.mp4');
			assert.equal('kitHiddenMedia' in a || 'image_url' in a || 'video_url' in a || 'title_link' in a, false);
		}
	});

	it('a shown video is still Rocket.Chat\'s own video attachment (no marker)', () => {
		const a = mediaAttachment({ kind: 'video', state: 'ready', url: 'blob:v', name: 'clip.mp4' } as never, host) as unknown as Att;
		assert.equal(a.video_url, 'blob:v');
		assert.equal('kitHiddenMedia' in a || 'image_url' in a, false);
	});

	const hiddenMessage = (b: ReturnType<typeof fixtureBridge>) =>
		b.putMessage(GENERAL, { ...b.timeline(GENERAL)[0], id: '$vid', body: 'clip.mp4', media: hidden } as never);
	const attachmentsOf = (src: InstanceType<typeof BridgeSource>) =>
		(src.history(GENERAL).find((m) => m._id === '$vid') as unknown as { attachments: Att[] }).attachments;

	it('the source marks a hidden video, hands the reveal to the bridge, and the video arrives with the next snapshot', async () => {
		const b = fixtureBridge();
		hiddenMessage(b);
		const src = new BridgeSource(b);
		assert.deepEqual(attachmentsOf(src)[0].kitHiddenMedia, { rid: GENERAL, eventId: '$vid' });
		assert.deepEqual(await src.showMedia(GENERAL, '$vid'), { status: 'done', roomId: GENERAL, eventId: '$vid' });
		assert.deepEqual(b.mediaReveals, [[GENERAL, '$vid']]);
		const [a] = attachmentsOf(src);
		assert.equal(a.video_url, 'http://hs/revealed.png');
		assert.equal('kitHiddenMedia' in a || 'image_url' in a, false);
	});

	it('an event that left the window is refused and the box stays', async () => {
		const b = fixtureBridge();
		hiddenMessage(b);
		const src = new BridgeSource(b);
		await assert.rejects(src.showMedia(GENERAL, '$gone'), { success: false });
		assert.deepEqual(attachmentsOf(src)[0].kitHiddenMedia, { rid: GENERAL, eventId: '$vid' });
	});

	it('rides the Z3 swap: one swapped attachment file, none for the video attachment', () => {
		const config = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
		assert.match(config, /replaceFile\(\/attachments\\\/file\\\/ImageAttachment\\\.tsx\$\/, src\('image-attachment\.tsx'\)\)/);
		assert.equal(/VideoAttachment/.test(config), false);
	});
});
