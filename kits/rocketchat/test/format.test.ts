// E1 (M7) dialect maps: Rocket.Chat markup <-> the CommonMark Element's composer sends. Run: node --test kits/rocketchat/test/
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromCommonMark, toCommonMark } from '../src/adapter/format.ts';

describe('toCommonMark (send)', () => {
	const cases: [string, string, string][] = [
		['bold', '*x*', '**x**'],
		['bold in a sentence', 'a *bold* word', 'a **bold** word'],
		['italic stays', '_x_', '_x_'],
		['strike single tilde', '~x~', '<del>x</del>'],
		['strike double tilde', '~~x~~', '<del>x</del>'],
		['rc link', '<https://example.org/a|Example>', '[Example](https://example.org/a)'],
		['rc link inside a sentence', 'see <https://example.org|this> now', 'see [this](https://example.org) now'],
		['commonmark link stays', '[t](https://example.org/a_b_c)', '[t](https://example.org/a_b_c)'],
		['already bold stays', '**x**', '**x**'],
		['plain text untouched', 'hello world', 'hello world'],
		['nested bold, italic', '*a _b_ c*', '**a _b_ c**'],
		['nested strike, bold', '~*x*~', '<del>**x**</del>'],
		['nested bold around strike', '*a ~b~ c*', '**a <del>b</del> c**'],
		['two marks', '*a* and *b*', '**a** and **b**'],
		['escaped bold', '\\*x\\*', '\\*x\\*'],
		['escaped strike', '\\~x\\~', '\\~x\\~'],
		['space inside marks is bold in RC, spaces move outside', '* x *', ' **x** '],
		['RC bold needs no word boundary', '2*3*4', '2**3**4'],
		['unpaired mark', '*x', '*x'],
		['inline code protected', '`*x*`', '`*x*`'],
		['code beside a mark', '`a` *b* `c`', '`a` **b** `c`'],
		['double backtick code', '``*x* ~y~``', '``*x* ~y~``'],
		['fence protected', '```\n*x* ~y~ <https://a.b|t>\n```', '```\n*x* ~y~ <https://a.b|t>\n```'],
		['text around a fence', '*a*\n```\n*b*\n```\n*c*', '**a**\n```\n*b*\n```\n**c**'],
		['unclosed fence protects the rest', '*a*\n```\n*b*', '**a**\n```\n*b*'],
		['bare URL protected', 'https://example.org/a_b_c/~x~', 'https://example.org/a_b_c/~x~'],
		['mark around a URL', '*see https://example.org/x*', '**see https://example.org/x**'],
		['rc link label is literal text in RC, so its marks are escaped', '<https://a.b|*t*>', '[\\*t\\*](https://a.b)'],
		['multi line', '*a*\n~b~', '**a**\n<del>b</del>'],
		['escaped backtick is no code span', '\\`*x*\\`', '\\`**x**\\`'],
	];
	for (const [name, input, expected] of cases) it(name, () => assert.equal(toCommonMark(input), expected));
});

describe('fromCommonMark (render)', () => {
	const cases: [string, string, string][] = [
		['single star italic', '*x*', '_x_'],
		['italic in a sentence', 'a *word* here', 'a _word_ here'],
		['bold stays', '**x**', '**x**'],
		['underscore italic stays', '_x_', '_x_'],
		['del tag', '<del>x</del>', '~x~'],
		['s tag', '<s>x</s>', '~x~'],
		['strike tag', '<strike>x</strike>', '~x~'],
		['del around bold', '<del>**x**</del>', '~**x**~'],
		['plain stays', 'hello', 'hello'],
		['inline code protected', '`*x*` and `<del>y</del>`', '`*x*` and `<del>y</del>`'],
		['fence protected', '```\n*x* <del>y</del>\n```', '```\n*x* <del>y</del>\n```'],
		['URL protected', 'https://example.org/a*b*c', 'https://example.org/a*b*c'],
		['link target protected', '[t](https://example.org/*a*)', '[t](https://example.org/*a*)'],
		['escaped star stays', '\\*x\\*', '\\*x\\*'],
		['arithmetic stays', '2*3*4', '2*3*4'],
		['strong with underscores is bold in Element', '__x__', '**x**'],
		['strong with underscores, in a sentence', 'a __word__ here', 'a **word** here'],
		['unwrapped autolink with a star', '<https://example.org/a*b*c>', 'https://example.org/a*b*c'],
		['bold and italic mixed', '**a** *b*', '**a** _b_'],
		['nested italic in bold', '**a *b* c**', '**a _b_ c**'],
	];
	for (const [name, input, expected] of cases) it(name, () => assert.equal(fromCommonMark(input), expected));
});

describe('grok F1-F6 (RC parser is the reference: message-parser grammar.pegjs)', () => {
	const cases: [string, string, string][] = [
		['F1 label cannot close the link', '<https://example.org/a|click](https://evil.example/phish)>', '[click\\](https://evil.example/phish)](https://example.org/a)'],
		['F1 label marks are literal', '<https://example.org/a|a *b* c>', '[a \\*b\\* c](https://example.org/a)'],
		['F1 label underscore and code are literal', '<https://example.org/a|x_y `z`>', '[x\\_y \\`z\\`](https://example.org/a)'],
		['F1 url parens are escaped', '<https://e.org/a(b)|t>', '[t](https://e.org/a\\(b\\))'],
		['F2 bare url with a star goes out as an autolink', 'see https://example.org/a*b*c and *now*', 'see <https://example.org/a*b*c> and **now**'],
		['F2 bare url without a star is untouched', 'see https://example.org/a_b_c and *now*', 'see https://example.org/a_b_c and **now**'],
		['F3 leading space inside bold moves out', '* Hello*', ' **Hello**'],
		['F3 trailing space inside bold moves out', '*Hello *', '**Hello** '],
		['F3 bold inside a word', 'f*oo*tball', 'f**oo**tball'],
		['F3 bold between digits', '2*3*4', '2**3**4'],
		['F3 punctuation edge that CommonMark would not open: the outer neighbour is a character reference (S1)', 'a*"b"*c', '&#97;**"b"**&#99;'],
		['F3 whitespace only is no mark', '* *', '* *'],
		['F4 __x__ is italic in RC', '__hello__', '_hello_'],
		['F4 __x__ in a sentence', 'say __hello__ now', 'say _hello_ now'],
		['F4 intraword underscores are text in RC', 'a__b__c', 'a__b__c'],
		['F4 snake_case stays', 'snake_case_name', 'snake_case_name'],
		['F4 italic with an inner space moves it out', '_ hello_', ' _hello_'],
		['F5 star pair split by a newline is literal', 'say *hello\nworld* please', 'say \\*hello\nworld\\* please'],
		['F5 underscore pair split by a newline is literal', 'say _hello\nworld_ please', 'say \\_hello\nworld\\_ please'],
		['F5 a single stray star is left', 'say *hello\nworld', 'say *hello\nworld'],
		['F5 non-flanking stars are left', '2 * 3\n4 * 5', '2 * 3\n4 * 5'],
		['F5 pairs on their own lines still convert', '*a*\n*b*', '**a**\n**b**'],
		['F6 strike glued to words', 'text~hello~text', 'text<del>hello</del>text'],
		['F6 double tilde glued to words', 'pre~~gone~~post', 'pre<del>gone</del>post'],
		['F6 strike with a leading space', '~ Hello~', ' <del>Hello</del>'],
		['F6 strike with a trailing space', '~Hello ~', '<del>Hello</del> '],
		['F6 tilde whitespace only is no mark', '~ ~', '~ ~'],
	];
	for (const [name, input, expected] of cases) it(name, () => assert.equal(toCommonMark(input), expected));
	it('F4 received __x__ (strong in Element) shows bold in RC', () => assert.equal(fromCommonMark('say __hello__ now'), 'say **hello** now'));
	it('F1 an escaped link label is shown as one RC link with a literal label', () => {
		const body = '[click\\](https://evil.example/phish)](https://example.org/a)';
		assert.equal(fromCommonMark(body), '<https://example.org/a|click](https://evil.example/phish)>');
	});
	it('F2 an autolink with a star shows as the bare URL', () => assert.equal(fromCommonMark('see <https://example.org/a*b*c>'), 'see https://example.org/a*b*c'));
	it('F2 an autolink without a star is left', () => assert.equal(fromCommonMark('<https://example.org/a>'), '<https://example.org/a>'));
	it('F2 round trip of a starred URL', () => assert.equal(fromCommonMark(toCommonMark('see https://example.org/a*b*c'), { formatted: true }), 'see https://example.org/a*b*c'));
});

describe('round trip', () => {
	for (const text of ['hello', '_x_', '`*x*`', '**x**', '[t](https://a.b)']) it(`send then render keeps ${text}`, () => assert.equal(fromCommonMark(toCommonMark(text), { formatted: true }), text));
	it('bold goes out as ** and shows as **', () => assert.equal(fromCommonMark(toCommonMark('*x*'), { formatted: true }), '**x**'));
	it('strike returns as ~x~', () => assert.equal(fromCommonMark(toCommonMark('~~x~~'), { formatted: true }), '~x~'));
});

// The sender's own row is the render of the body Element holds: it must show what was typed. Each case's echo was compared
// with the typed text through Rocket.Chat's own parser (message-parser grammar.pegjs): same tree, except where noted.
describe('own echo (send then render) shows what was typed', () => {
	const same = [
		['F1 link label marks', '<https://example.org/a|a *b* c>', '<https://example.org/a|a *b* c>'],
		['F1 link label underscore and code', '<https://example.org/a|x_y `z`>', '<https://example.org/a|x_y `z`>'],
		['F1 label that tries to close the link', '<https://example.org/a|click](https://evil.example/phish)>', '<https://example.org/a|click](https://evil.example/phish)>'],
		['F1 label backslash', '<https://example.org/a|a\\b *c*>', '<https://example.org/a|a\\b *c*>'],
		// RC's `<url|t>` cannot carry a `)` in the URL; its markdown link can (one balanced level): the echo is that link, with the
		// typed URL character for character. The label's stars become RC's bold there (a markdown link label has no escape).
		['F3 url with parens: markdown link, exact href', '<https://example.org/a_(b)|a *label*>', '[a *label*](https://example.org/a_(b))'],
		['F2 bare url with a star', 'see https://example.org/a*b*c and *now*', 'see https://example.org/a*b*c and **now**'],
		['F2 bare url with a star only', 'https://example.org/a*b*c', 'https://example.org/a*b*c'],
		['F3 bold glued to words', 'f*oo*tball', 'f**oo**tball'],
		['F3 bold edge that needs the tag', 'a*"b"*c', 'a**"b"**c'],
		['F3 nested tag forms', 'x*"~a~"*y', 'x**"~a~"**y'],
		['F4 __x__', 'say __hello__ now', 'say _hello_ now'],
		['F4 intraword underscores', 'a__b__c', 'a__b__c'],
		['F5 star pair split by a newline (RC reads \\* as *)', 'say *hello\nworld* please', 'say \\*hello\nworld\\* please'],
		['F5 underscore pair split by a newline', 'say _hello\nworld_ please', 'say \\_hello\nworld\\_ please'],
		['F6 strike glued to words', 'text~hello~text', 'text~hello~text'],
		['F6 strike nested in bold', '*a ~b~ c*', '**a ~b~ c**'],
		['F6 bold nested in strike', '~*a*~', '~**a**~'],
	] as const;
	for (const [name, typed, echo] of same) it(name, () => assert.equal(fromCommonMark(toCommonMark(typed), { formatted: true }), echo));
	it('typed text without a mapped mark comes back unchanged', () => {
		for (const t of ['hello', 'a * b', '2 * 3\n4 * 5', '<https://example.org/a>', '`*x*` and `<del>y</del>`']) assert.equal(fromCommonMark(toCommonMark(t), { formatted: true }), t);
	});
	it('a link the escapes cannot express stays as the wire has it', () => {
		const wire = '[a\\>b](https://example.org/a\\\\c)';
		assert.equal(fromCommonMark(wire), wire);
	});
	it('received tags map to marks', () => assert.equal(fromCommonMark('<strong>a</strong> <em>b</em> <del>c</del>'), '**a** _b_ ~c~'));
	it('a link with no escape is left alone', () => assert.equal(fromCommonMark('[t](https://example.org/a)'), '[t](https://example.org/a)'));
});

// fix round 3 (grok delta 72b726f..eda105a): the href in the RC row is the one in Element's formatted_body, character for character.
const hrefOf = (row: string): string | undefined => /^\[.*\]\((.*)\)$/.exec(row)?.[1] ?? /^<([^|>]+)\|.*>$/.exec(row)?.[1];
describe('link target with parentheses (F1/F3), label with < or | (F2), emphasis tags (F4)', () => {
	const links: [string, string, string, string][] = [
		['F1 wikipedia balanced parens, starred label', '[click \\*here\\*](https://en.wikipedia.org/wiki/Foo_(bar))', '[click *here*](https://en.wikipedia.org/wiki/Foo_(bar))', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
		['F1 query with parens', '[search \\*q\\*](https://example.org/search?q=(cats))', '[search *q*](https://example.org/search?q=(cats))', 'https://example.org/search?q=(cats)'],
		['F1 fragment after the closing paren stays in the link', '[a \\*b\\*](https://example.org/wiki/C_(programming_language)#See_also)', '[a *b*](https://example.org/wiki/C_(programming_language)#See_also)', 'https://example.org/wiki/C_(programming_language)#See_also'],
		['F3 escaped parens in the target', '[labelword \\*starlabel\\*](https://example.org/a_\\(b\\))', '[labelword *starlabel*](https://example.org/a_(b))', 'https://example.org/a_(b)'],
		['F2 label with <', '[a\\<b \\*c\\*](https://example.org/x)', '[a<b *c*](https://example.org/x)', 'https://example.org/x'],
		['F2 label with |', '[a\\|b \\*c\\*](https://example.org/x)', '[a|b *c*](https://example.org/x)', 'https://example.org/x'],
		['F2 label with < and a paren target', '[a\\<b](https://example.org/a_(b))', '[a<b](https://example.org/a_(b))', 'https://example.org/a_(b)'],
	];
	for (const [name, wire, row, href] of links)
		it(`${name}: keeps the markdown link, exact href`, () => {
			assert.equal(fromCommonMark(wire), row);
			assert.equal(hrefOf(fromCommonMark(wire)), href);
		});
	it('F3 typed <url|label> with parens: no %28/%29 in the row', () => {
		for (const [typed, href] of [
			['<https://example.org/a_(b)|labelword *starlabel*>', 'https://example.org/a_(b)'],
			['<https://en.wikipedia.org/wiki/C_(programming_language)|C *lang*>', 'https://en.wikipedia.org/wiki/C_(programming_language)'],
		]) {
			const row = fromCommonMark(toCommonMark(typed), { formatted: true });
			assert.equal(hrefOf(row), href);
			assert.ok(!/%2[89]/.test(row));
		}
	});
	it('F1 a link with an unescaped balanced paren target and a plain label is left alone', () => {
		const wire = '[click here](https://en.wikipedia.org/wiki/Foo_(bar))';
		assert.equal(fromCommonMark(wire), wire);
	});
	it('F1 a target RC cannot carry (nested parens, a backslash) stays as the wire has it', () => {
		for (const wire of ['[a \\*b\\*](https://example.org/a_((b)))', '[a \\*b\\*](https://example.org/a\\\\c)']) assert.equal(fromCommonMark(wire), wire);
	});
	it('F1 a markdown link typed with a balanced paren target is not cut when sent', () => {
		const typed = '[t](https://en.wikipedia.org/wiki/Foo_(bar)) and *now*';
		assert.equal(toCommonMark(typed), '[t](https://en.wikipedia.org/wiki/Foo_(bar)) and **now**');
	});
	it('F4 em touching a letter: RC has no intraword italic, so plain text without markers', () => {
		assert.equal(fromCommonMark('<em>not</em>able'), 'notable');
		assert.equal(fromCommonMark('un<em>do</em> it'), 'undo it');
	});
	it('F4 em with an underscore inside: RC cannot close it, plain text without markers', () => assert.equal(fromCommonMark('<em>a_b</em> c'), 'a_b c'));
	it('F4 em at a word edge still shows italic', () => assert.equal(fromCommonMark('a <em>not</em> b, <em>x</em>.'), 'a _not_ b, _x_.'));
	it('F4 strong touching a letter is bold (RC bold needs no boundary)', () => assert.equal(fromCommonMark('<strong>not</strong>able'), '**not**able'));
	it('F4 nested strong is one bold run (RC cannot nest ** in **)', () => {
		assert.equal(fromCommonMark('<strong>a <strong>b</strong> c</strong>'), '**a b c**');
		assert.equal(fromCommonMark('<strong>a <em>b</em> <strong>c</strong></strong>'), '**a _b_ c**');
	});
	it('F4 nested em and nested del are one run', () => {
		assert.equal(fromCommonMark('<em>a <em>b</em> c</em>'), '_a b c_');
		assert.equal(fromCommonMark('<del>a <del>b</del> c</del>'), '~a b c~');
	});
});

describe('send side S1-S5 (grok 101656): no <strong>/<em>, adjacent pairs, edge spaces, cross-line stars, digit after italic', () => {
	const cases: [string, string, string][] = [
		['S1 bold with punctuation edges between letters: neighbours as character references', 'a*"b"*c', '&#97;**"b"**&#99;'],
		['S1 only the opening side needs the reference', 'a*"b" c*', '&#97;**"b" c**'],
		['S1 only the closing side needs the reference', '*b "c"*d', '**b "c"**&#100;'],
		['S1 italic after a non-ASCII letter', 'café_bonjour_', 'caf&#233;_bonjour_'],
		['S1 a protected neighbour (URL) cannot be encoded: the typed stars are kept, escaped (fix5 F3)', '*"b"*https://example.org', '\\*"b"\\*https://example.org'],
		['S1 no tag is ever sent', 'x*"~a~"*y', '&#120;**"<del>a</del>"**&#121;'],
		['S2 adjacent bold pairs are one bold run', '*a**b*', '**ab**'],
		['S2 adjacent strike pairs are one strike run', '~a~~b~', '<del>ab</del>'],
		['S2 adjacent italic pairs are one italic run', '_a__b_', '_ab_'],
		['S2 adjacent bold pairs in a sentence', 'x *a**b* y', 'x **ab** y'],
		['S3 ** with a leading space', '** hello**', ' **hello**'],
		['S3 ** with a trailing space', '**hello **', '**hello** '],
		['S3 __ with a leading space', '__ hello__', ' _hello_'],
		['S3 ** without edge spaces stays', '**hello**', '**hello**'],
		['S4 an opener-only star on each line is left (the newline survives)', 'say *hello\n*world please', 'say *hello\n*world please'],
		['S4 a closer-only star on each line is left', 'say hello*\nworld* please', 'say hello*\nworld* please'],
		['S4 underscores that only open are left', 'say _hello\n_world', 'say _hello\n_world'],
		['S4 a pair CommonMark can close across the newline is still escaped', 'say *hello\nworld* please', 'say \\*hello\nworld\\* please'],
		['S5 italic before a digit: the digit is a character reference', '_hello_1', '_hello_&#49;'],
		['S5 italic before a letter is text in RC', '_hello_a', '_hello_a'],
		['S5 double underscore before a digit is text in RC', '__hello__1', '__hello__1'],
	];
	for (const [name, input, expected] of cases) it(name, () => assert.equal(toCommonMark(input), expected));
	it('S1/S5 render decodes numeric character references outside code, links and fences', () => {
		assert.equal(fromCommonMark('&#97;**"b"**&#99;', { formatted: true }), 'a**"b"**c');
		assert.equal(fromCommonMark('caf&#xE9;_bonjour_', { formatted: true }), 'caf\u00e9_bonjour_');
		assert.equal(fromCommonMark('_hello_&#49;', { formatted: true }), '_hello_1');
		assert.equal(fromCommonMark('`&#97;` and **&#98;**', { formatted: true }), '`&#97;` and **b**');
		assert.equal(fromCommonMark('[t](https://example.org/?q=&#97;) **&#98;**', { formatted: true }), '[t](https://example.org/?q=&#97;) **b**');
		assert.equal(fromCommonMark('```\n&#97;\n```\n**&#98;**', { formatted: true }), '```\n&#97;\n```\n**b**');
	});
	it('S1 render: a reference to a mark character stays as received (fix5 F1: only letters and digits beside a mark decode)', () => {
		assert.equal(fromCommonMark('a &#42;x&#42; b', { formatted: true }), 'a &#42;x&#42; b');
		assert.equal(fromCommonMark('&#95;x&#95;', { formatted: true }), '&#95;x&#95;');
	});
	it('S1 render: a reference that is no character stays as it is', () => {
		for (const t of ['&#0;', '&#xD800;', '&#1114112;', '&#xe000;', '&#97', '&amp;']) assert.equal(fromCommonMark(t, { formatted: true }), t);
	});
	it('own echo of the new forms shows what was typed (a bold mark shows as RC bold)', () => {
		const echo: [string, string][] = [
			['a*"b"*c', 'a**"b"**c'],
			['a*"b" c*', 'a**"b" c**'],
			['*b "c"*d', '**b "c"**d'],
			['café_bonjour_', 'café_bonjour_'],
			['_hello_1', '_hello_1'],
			['*a**b*', '**ab**'],
		];
		for (const [typed, shown] of echo) assert.equal(fromCommonMark(toCommonMark(typed), { formatted: true }), shown);
	});
});

// fix round 5 (grok e1t-delta3 F1/F3): decode only the references the send map writes; never delete typed stars.
describe('fix5 F1 render decodes only its own references; F3 typed stars are never deleted', () => {
	it('F1 a reference to link or tag punctuation stays as received text', () => {
		const a = '&#91;PayPal&#93;(https://evil.example)';
		assert.equal(fromCommonMark(a, { formatted: true }), a);
		const b = 'a &#60;em&#62;not&#60;/em&#62;able';
		assert.equal(fromCommonMark(b, { formatted: true }), b);
		const c = 'see &#60;https://evil.example|click&#62;';
		assert.equal(fromCommonMark(c, { formatted: true }), c);
	});
	it('F1 (fix6: plain body only) a letter or digit reference away from a mark stays as received text', () => {
		for (const t of ['&#97; b', 'x &#49;y', '&#97;&#98;', 'a **b** &#99; d']) assert.equal(fromCommonMark(t, { formatted: false }), t);
	});
	it('F1 the shapes toCommonMark writes (S1/S5) still decode', () => {
		assert.equal(fromCommonMark('&#97;**"b"**&#99;', { formatted: true }), 'a**"b"**c');
		assert.equal(fromCommonMark('_hello_&#49;', { formatted: true }), '_hello_1');
		assert.equal(fromCommonMark('caf&#233;_bonjour_', { formatted: true }), 'caf\u00e9_bonjour_');
		assert.equal(fromCommonMark('&#120;<del>"a"</del>&#121;', { formatted: true }), 'x~"a"~y');
		for (const typed of ['a*"b"*c', 'a*"b" c*', '*b "c"*d', 'café_bonjour_', '_hello_1']) {
			assert.equal(fromCommonMark(toCommonMark(typed), { formatted: true }), typed.replace(/\*/g, '**'));
		}
	});
	it('F3 a pair that cannot be encoded keeps its stars, escaped', () => {
		assert.equal(toCommonMark('a*"b"*c*"d"*e'), '&#97;**"b"**&#99;\\*"d"\\*e');
		assert.equal(toCommonMark('*"b"*https://example.org'), '\\*"b"\\*https://example.org');
	});
	it('F3 the RC row of a pair with escaped stars shows the stars', () => {
		assert.equal(fromCommonMark(toCommonMark('a*"b"*c*"d"*e'), { formatted: true }), 'a**"b"**c\\*"d"\\*e');
	});
});

// Element's own render of the wire string (commonmark.js, as Element Web uses it); skipped where the package is not installed.
const commonmark = await import('/home/waldknoten-01/aqua-meet/portal/node_modules/commonmark/dist/commonmark.js').then(
	(m) => m.default ?? m,
	() => undefined,
);
describe('fix5 F3 Element renders the escaped stars as typed', { skip: !commonmark }, () => {
	const html = (md: string): string => new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(md)).trim();
	it('a*"b"*c*"d"*e: first bold, second pair literal stars', () => {
		assert.equal(html(toCommonMark('a*"b"*c*"d"*e')), '<p>a<strong>&quot;b&quot;</strong>c*&quot;d&quot;*e</p>');
	});
	it('an unencodable pair shows its stars', () => {
		assert.equal(html(toCommonMark('*"b"*https://example.org')), '<p>*&quot;b&quot;*https://example.org</p>');
	});
});

// fix round 6 (grok e1 delta4 F1-F3): a reference decodes only when Element shows the body rendered (formattedBody present),
// then every letter/number/mark reference decodes wherever it stands; a plain body shows exactly as stored.
describe('fix6 render decodes references by whether the message is formatted', () => {
	const plain = (b: string): string => fromCommonMark(b, { formatted: false });
	const formatted = (b: string): string => fromCommonMark(b, { formatted: true });
	it('F1 a plain body never decodes a reference (no mention or channel pill of another name)', () => {
		for (const t of ['@admi&#110;_', '#genera&#108;_', '&#97;**"b"**&#99;', '_hello_&#49;', 'a **b** &#99; d']) assert.equal(plain(t), t);
		assert.equal(fromCommonMark('@admi&#110;_'), '@admi&#110;_');
	});
	it('F2 a formatted body decodes every letter or digit reference, beside a mark or not', () => {
		assert.equal(formatted('a **b** &#99; d'), 'a **b** c d');
		for (const [t, shown] of [['&#97; b', 'a b'], ['x &#49;y', 'x 1y'], ['&#97;&#98;', 'ab'], ['@admi&#110;_', '@admin_']] as const) assert.equal(formatted(t), shown);
	});
	it('F3 a formatted body decodes a combining mark reference (the send map writes one beside a pair)', () => {
		assert.equal(formatted('e&#769;**"b"**&#122;'), 'e\u0301**"b"**z');
		assert.equal(formatted(toCommonMark('e\u0301*"b"*z')), 'e\u0301**"b"**z');
	});
	it('a formatted body keeps punctuation, tag, link and invalid references literal', () => {
		for (const t of ['&#91;x&#93;(http://a)', '&#60;em&#62;', '&#42;x&#42;', '&#0;', '&#xD800;', '&#1114112;', '&#xe000;', '&#97', '&amp;']) assert.equal(formatted(t), t);
	});
});
