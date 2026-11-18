// M12 Z3: the swapped image attachment is wired into the bundle and answers the Load box with Element's reveal.
// Source checks (the component needs Rocket.Chat's React tree); the data side is in adapter.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('M12 Z3: image-attachment.tsx', () => {
	const source = read('../src/image-attachment.tsx');

	it('is swapped in for Rocket.Chat\'s ImageAttachment in the bundle', () => {
		assert.match(read('../webpack.config.js'), /replaceFile\(\/attachments\\\/file\\\/ImageAttachment\\\.tsx\$\/, src\('image-attachment\.tsx'\)\)/);
	});

	it('renders Rocket.Chat\'s own Load box (loadImage false) for the marker and presses Element\'s reveal, with the error toast', () => {
		assert.match(source, /kitHiddenMedia/);
		assert.match(source, /\.showMedia\(\s*hidden\.rid,\s*hidden\.eventId\s*\)/);
		assert.match(source, /image\(false,\s*\(\) => revealHiddenMedia\(kitHiddenMedia\)\)/);
		assert.match(source, /dispatchToastMessage\(\{ type: 'error', message: error \}\)/);
		// The unmarked image is the original: Rocket.Chat's own load state and setter.
		assert.match(source, /image\(loadImage, setLoadImage\)/);
		assert.match(source, /AttachmentImage from 'rc\/client\/components\/message\/content\/attachments\/structure\/AttachmentImage'/);
	});

	it('keeps no state of its own for the reveal (the image arrives with the next snapshot)', () => {
		assert.equal(/useState|useRef|useEffect/.test(source), false);
		assert.match(source, /data-kit-media-reveal/);
	});
});
