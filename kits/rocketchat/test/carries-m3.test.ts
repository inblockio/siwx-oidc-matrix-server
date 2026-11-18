// M3 carries: kit inc1 F4 (a jump id survives Rocket.Chat's double decode of `msg`) and kit inc2 F2 (a reaction key
// without a Rocket.Chat emoji name renders as its own text, escaped). Run: node --test kits/rocketchat/test/.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jumpParam, messageLink } from '../src/adapter/map.ts';
import { registerTextReaction, textEmojiHtml } from '../src/reaction-text.ts';

// Rocket.Chat's read of `msg`: page.ts decodes the whole query string (`+` -> space, then decodeURIComponent), then
// the router parses it again with URLSearchParams.
const rcReadMsg = (href: string): string | null => {
	const i = href.indexOf('?');
	return new URLSearchParams(decodeURIComponent(href.slice(i + 1).replace(/\+/g, ' '))).get('msg');
};
// Rocket.Chat's write of a search object (router.encodeSearchParameters), as the jump-param swap navigates.
const rcWriteMsg = (value: string): string => `/channel/x?${new URLSearchParams({ msg: value }).toString()}`;

const ids = ['$p', '$a+b:example.org', '$100%25/x&y=z:example.org', '$sp ace#h:example.org'];

describe('jump id through Rocket.Chat\'s double decode (kit inc1 F4)', () => {
	it('a quote link names the same event after page.ts and URLSearchParams', () => {
		for (const id of ids) assert.equal(rcReadMsg(messageLink({ _id: '!r:example.org', t: 'c', name: 'r' } as never, id)), id);
	});
	it('a jump navigation (jumpParam through the router\'s encoder) names the same event', () => {
		for (const id of ids) assert.equal(rcReadMsg(rcWriteMsg(jumpParam(id))), id);
	});
});

describe('reaction key without an emoji name (kit inc2 F2)', () => {
	it('is registered once as its own emoji whose render is the key as text', () => {
		const registry = { packages: {} as Record<string, { render(n: string): string }>, list: {} as Record<string, { emojiPackage: string }> };
		registerTextReaction(registry, 'lol');
		registerTextReaction(registry, 'lol');
		const pkg = registry.list.lol.emojiPackage;
		assert.equal(Object.keys(registry.list).length, 1);
		assert.equal(registry.packages[pkg].render('lol'), textEmojiHtml('lol'));
		assert.match(textEmojiHtml('lol'), />lol</);
	});
	it('escapes a hostile key (a reaction key is any room member\'s text)', () => {
		const html = textEmojiHtml('<img src=x onerror=alert(1)>"\'&');
		assert.equal(html.includes('<img'), false);
		assert.equal(/"[^"]*"[^"]*"/.test(html.replace(/="[^"]*"/g, '')), false);
		assert.match(html, /&#60;img src=x onerror=alert\(1\)&#62;&#34;&#39;&#38;/);
	});
	it('a key Rocket.Chat already names is not registered over', () => {
		const registry = { packages: {}, list: { ':x:': { emojiPackage: 'native' } } as Record<string, { emojiPackage: string }> };
		registerTextReaction(registry, ':x:');
		assert.equal(registry.list[':x:'].emojiPackage, 'native');
	});
});
