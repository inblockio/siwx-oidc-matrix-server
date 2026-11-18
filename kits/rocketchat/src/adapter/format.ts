// E1 (M7): the dialect map between Rocket.Chat's message markup and the CommonMark Element's composer sends.
//
// Send (`toCommonMark`): `*x*` -> `**x**`, `~x~` / `~~x~~` -> `<del>x</del>` (Element's Markdown has no `~~`; `del` is an
// allowed tag), `<url|t>` -> `[t](url)`, `__x__` -> `_x_` (italic in RC, strong in CommonMark); code, fences and `[t](url)`
// stay. Rocket.Chat's parser (message-parser `grammar.pegjs`) is the reference for what a mark is: bold and strike need no
// word boundary and may hold spaces at their edges (`f*oo*tball`, `* Hello*`, `~ x~`), italic `_` does need one, a mark never
// spans a newline, and a link label is literal text. CommonMark is stricter, so a mark RC shows has its edge spaces moved
// outside and, where CommonMark would still not open it, the outer neighbour goes out as a numeric character reference
// (`a*"b"*c` -> `&#97;**"b"**&#99;`: Element's Markdown has no `<strong>` / `<em>`); two pairs closed against each other
// (`*a**b*`) are one mark; a star or underscore RC leaves literal but CommonMark would pair across a newline is
// backslash-escaped (one that cannot pair is sent as typed, the backslash would cost the newline). Render (`fromCommonMark`): numeric character
// references of a formatted body are decoded (outside code, links, fences; a plain body is shown as stored) and a received body is mapped back so Rocket.Chat's parser shows what Element shows: CommonMark's single `*x*` (italic) -> `_x_`, `__x__`
// (strong) -> `**x**`, `<strong>` / `<em>` / `<del>` / `<s>` / `<strike>` -> `**x**` / `_x_` / `~x~`, `<url*>` autolink -> the
// bare URL, an escaped `[t](u)` link -> RC's `<u|t>` (a literal label, or the markdown link when the URL has parentheses). A backslash before a star or underscore stays: RC's
// `Escaped` rule reads `\*` as `*`, so the sender's own row shows what was typed. Both maps act only outside
// code spans, fences and URLs, and leave an escaped mark (`\*`) as it is.

// What a map must not touch, in order of precedence: a fence, a code span, a Rocket.Chat link `<url|t>` or a CommonMark
// link `[t](url)` (handled by the callers where it needs a rewrite), a bare URL.
const FENCE = /```[\s\S]*?(?:```|$)/y;
const CODE = /(`+)(?:(?!\1)[\s\S])+?\1(?!`)/y;
const RC_LINK = /<((?:https?|mailto):[^|>\s]+)\|([^>\n]+)>/y;
// A CommonMark link destination may hold balanced parentheses (two levels here), so the first `)` is not always its end.
const DEST = String.raw`(?:\\.|\((?:\\.|\((?:\\.|[^()\s\\])*\)|[^()\s\\])*\)|[^()\s\\])*`;
const LABEL = String.raw`(?:\\.|[^\]\n\\])*`;
const MD_LINK = new RegExp(String.raw`\[${LABEL}\]\(${DEST}\)`, 'y');
const MD_LINK_PARTS = new RegExp(String.raw`^\[(${LABEL})\]\((${DEST})\)$`);
// An autolink `<url>` (the send map writes one for a URL with a star in it).
const AUTO = /<(?:https?|mailto):[^\s<>|]+>/y;
// A trailing mark or punctuation is not part of the URL (`*see https://x.org*`).
const URL_RE = /(?:https?:\/\/|mailto:)[^\s<>]*[^\s<>*_~.,;:!?)\]'"]/y;
const SCAN = [FENCE, CODE, RC_LINK, AUTO, MD_LINK, URL_RE];

type Kind = 'code' | 'rclink' | 'auto' | 'mdlink' | 'url';
const KINDS: Kind[] = ['code', 'code', 'rclink', 'auto', 'mdlink', 'url'];
// A protected piece stands in the text as one private-use character, so a mark pair can span it (`*see https://x.org*`)
// and the digits of an index never touch a word boundary.
const HOLE = 0xe000;

const ASCII_ESCAPE = /\\([!-/:-@[-`{-~])/g;
// What Rocket.Chat's parser accepts (message-parser `grammar.pegjs`): a `<url|label>` label is LinkTitle2 (no `<`, `>`, `|`)
// and its URL has no `(`/`)` or backslash; a markdown link `[label](url)` URL may hold one level of balanced parentheses but
// no backslash or `|`, and its label ends at the first `]`. A label has no escapes in either form.
const RC_ANGLE_LABEL = /^[\x20-\x3B\x3D\x3F-\x60a-\x7B\x7D-\xFF\u0100-\uffff]+$/;
const RC_ANGLE_URL = /^(?:https?|mailto):[^|>\s()\\]+$/;
const RC_MD_URL = /^(?:https?|mailto):(?:[^|>\s()\\]|>|\([^()|\s\\]*\))+$/;
/**
 * The send map writes a link label and URL with CommonMark escapes (`[a \*b\*](u_\(x\))`). Rocket.Chat's `[t](u)` parser has
 * no label escapes (the backslash would show, the marks would still apply), so the escaped link is shown in the form that
 * carries it: `<url|label>` (literal label) when label and URL fit it, else the markdown link with the unescaped label and the
 * URL exactly as typed (a label's stars then show as RC's bold: RC has no way to write a literal star there). A link neither
 * form can carry stays as it is.
 */
const rcLink = (text: string): string => {
	const m = MD_LINK_PARTS.exec(text);
	if (!m) return text;
	const label = m[1].replace(ASCII_ESCAPE, '$1');
	const url = m[2].replace(ASCII_ESCAPE, '$1');
	if (!label || /\n/.test(label)) return text;
	if (RC_ANGLE_LABEL.test(label) && RC_ANGLE_URL.test(url)) return `<${url}|${label}>`;
	if (!/[\]\\]/.test(label) && RC_MD_URL.test(url)) return `[${label}](${url})`;
	return text;
};

/** Replaces every protected piece by a placeholder; `restore` puts them back (rewriting `<url|t>` for the send map). */
const protect = (
	text: string,
): { text: string; restore: (mapped: string, rewrite: boolean) => string; edge: (ch: string, last: boolean) => string } => {
	const kept: { text: string; kind: Kind }[] = [];
	let out = '';
	let i = 0;
	while (i < text.length) {
		let hit: { text: string; kind: Kind } | undefined;
		// A protected piece starts only at its first character: a backslash-escaped backtick is not a code span.
		const c = text[i];
		if ((c === '`' || c === '<' || c === '[' || c === 'h' || c === 'm') && text[i - 1] !== '\\') {
			for (let k = 0; k < SCAN.length && !hit; k++) {
				const re = SCAN[k];
				re.lastIndex = i;
				const m = re.exec(text);
				if (m) hit = { text: m[0], kind: KINDS[k] };
			}
		}
		if (hit) {
			out += String.fromCharCode(HOLE + kept.length);
			kept.push(hit);
			i += hit.text.length;
		} else out += text[i++];
	}
	const restore = (mapped: string, rewrite: boolean) =>
		mapped.replace(/[\ue000-\uf8ff]/g, (ch) => {
			const piece = kept[ch.charCodeAt(0) - HOLE];
			if (!piece) return ch;
			if (rewrite && piece.kind === 'rclink') {
				const m = /^<([^|]+)\|(.+)>$/.exec(piece.text)!;
				// RC's label is literal text: its marks must not become CommonMark; the URL's parens and backslashes are escaped.
				return `[${m[2].replace(/[\\[\]*_`<&]/g, '\\$&')}](${m[1].replace(/[\\()]/g, '\\$&')})`;
			}
			// Element's `repairLinks` rewrites a star inside a bare URL as emphasis: an autolink keeps the URL as it is.
			if (rewrite && piece.kind === 'url' && piece.text.includes('*')) return `<${piece.text}>`;
			if (!rewrite && piece.kind === 'auto' && piece.text.includes('*')) return piece.text.slice(1, -1);
			if (!rewrite && piece.kind === 'mdlink' && piece.text.includes('\\')) return rcLink(piece.text);
			return piece.text;
		});
	// The character a placeholder (or a mark sentinel) stands for at its first / last position, for the flanking checks.
	const edge = (ch: string, last: boolean): string => {
		const code = ch.charCodeAt(0);
		if (code === STAR) return '*';
		if (code === UNDER) return '_';
		const piece = kept[code - HOLE];
		if (code < HOLE || code > 0xf8ff || !piece) return ch;
		if (piece.kind === 'rclink' || piece.kind === 'mdlink') return last ? ')' : '[';
		return last ? piece.text[piece.text.length - 1] : piece.text[0];
	};
	return { text: out, restore, edge };
};

// Rocket.Chat's pairs (a mark never spans a newline): bold and strike take one or two marks and need no word boundary;
// italic `_` takes one or two and does (`snake_case_name`, `a__b__c` are text). Content may start or end with a space.
const RC_BOLD = /(?<![\\*])(\*\*?)(?!\*)([^*\n]+?)\1(?!\*)/g;
const RC_STRIKE = /(?<![\\~])(~~?)(?!~)([^~\n]+?)\1(?!~)/g;
const RC_ITALIC = /(?<![\\\w_])(_{1,2})(?!_)([^_\n]+?)\1(?!_)/g;
// Two pairs of one kind closed against each other (`*a**b*`): RC reads two marks, CommonMark would re-pair the run. They are
// one mark (the same look in RC, one run for CommonMark).
const MERGE_BOLD = /(?<![\\*])(\*\*?)(?!\*)([^*\n]+?)\1\1([^*\n]+?)\1(?!\*)/g;
const MERGE_STRIKE = /(?<![\\~])(~~?)(?!~)([^~\n]+?)\1\1([^~\n]+?)\1(?!~)/g;
const MERGE_ITALIC = /(?<![\\\w_])(_{1,2})(?!_)([^_\n]+?)\1\1([^_\n]+?)\1(?![\w_])/g;
// What a received body's CommonMark marks mean (opener not followed by a space, closer not preceded by one, no word
// character touching the outer side: RC has no intraword italic, so `f*oo*tball` is left as it is).
const CM_ITALIC = /(?<![\\*\w])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![*\w])/g;
const CM_STRONG_US = /(?<![\\_\w])__(?=[^\s_])([^_\n]*?[^\s_\\])__(?![_\w])/g;
// The tags the send map writes (and an Element user may type): the innermost pair is replaced first, until none is left.
const MARK_TAG = /<(strong|em|s|del|strike)>((?:(?!<\/?(?:strong|em|s|del|strike)>)[^\n])*?)<\/\1>/g;
// A tag's mark is held as a sentinel until the end (like a mark in the send map): nested marks of the same kind are one run
// in RC (it cannot nest `**` in `**`), and an `<em>` RC's italic would not open or close stays plain text.
const TAG_SENT: Record<string, string> = { strong: '\uf8f2', em: '\uf8f3', s: '\uf8f4', del: '\uf8f4', strike: '\uf8f4' };
const TAG_MARK: Record<string, string> = { '\uf8f2': '**', '\uf8f3': '_', '\uf8f4': '~' };
const markTags = (text: string): string => {
	for (let prev = ''; prev !== text; ) {
		prev = text;
		text = text.replace(MARK_TAG, (_w, tag: string, inner: string, at: number, str: string) => {
			const sent = TAG_SENT[tag];
			const flat = inner.split(sent).join('');
			if (sent === TAG_SENT.em) {
				// RC's italic: no word character or underscore outside, no underscore inside.
				const before = str[at - 1] ?? '';
				const after = str[at + _w.length] ?? '';
				if (/[\w_\\]/.test(before) || /[\w_]/.test(after) || /_/.test(flat)) return flat;
			}
			return `${sent}${flat}${sent}`;
		});
	}
	return text;
};
const untag = (text: string): string => text.replace(/[\uf8f2-\uf8f4]/g, (c) => TAG_MARK[c]);

// A mark RC read is held in the text as a sentinel until the end, so a later pass (and the stray-mark pass) tells it from
// a literal star or underscore.
const STAR = 0xf8f0;
const UNDER = 0xf8f1;
const SENTINEL = { '*': String.fromCharCode(STAR), _: String.fromCharCode(UNDER) } as const;

const isWs = (c: string) => c === '' || /\s/.test(c);
const isPunct = (c: string) => /[\p{P}\p{S}]/u.test(c);
// CommonMark's flanking rules for a delimiter run between `p` (before) and `n` (after).
const leftFlank = (p: string, n: string) => !isWs(n) && (!isPunct(n) || isWs(p) || isPunct(p));
const rightFlank = (p: string, n: string) => !isWs(p) && (!isPunct(p) || isWs(n) || isPunct(n));
const opens = (mark: '*' | '_', p: string, n: string) =>
	mark === '*' ? leftFlank(p, n) : leftFlank(p, n) && (!rightFlank(p, n) || isPunct(p));
const closes = (mark: '*' | '_', p: string, n: string) =>
	mark === '*' ? rightFlank(p, n) : rightFlank(p, n) && (!leftFlank(p, n) || isPunct(n));

type Emphasis = { marked: string; plain: string; encBefore: boolean; encAfter: boolean };

/**
 * One RC mark pair as CommonMark: the edge spaces move outside; the mark is `**` / `_`. Where CommonMark's flanking rules would
 * not open (close) it, the outer neighbour goes out as a numeric character reference (`&#97;`), a punctuation character to
 * the rules, so the same mark flanks; the caller applies that, or falls back to `plain` (no mark) when it cannot.
 */
const emphasis = (
	mark: '*' | '_',
	inner: string,
	before: string,
	after: string,
	edge: (ch: string, last: boolean) => string,
): Emphasis | undefined => {
	const core = inner.trim();
	if (!core) return undefined;
	const lead = inner.slice(0, inner.length - inner.trimStart().length);
	const trail = inner.slice(inner.trimEnd().length);
	const prev = lead ? lead[lead.length - 1] : before === '' ? '' : edge(before, true);
	const next = trail ? trail[0] : after === '' ? '' : edge(after, false);
	const first = edge(core[0], false);
	const last = edge(core[core.length - 1], true);
	// A neighbour that does not flank the mark is encoded; encoded, it is punctuation to the rules.
	const encBefore = !lead && !opens(mark, prev, first);
	const encAfter = !trail && !closes(mark, last, next);
	const body = SENTINEL[mark].repeat(mark === '*' ? 2 : 1);
	return { marked: `${lead}${body}${core}${body}${trail}`, plain: inner, encBefore, encAfter };
};

/**
 * Applies `fn` to every match of `re` in `text`. A pair that needs a neighbour encoded gets it when the neighbour is one
 * ordinary character that no other pair or protected piece uses, else its marks are sent escaped (literal, as typed).
 */
const literal = (marks: string): string => [...marks].map((c) => `\\${c}`).join('');

const mapPairs = (
	text: string,
	re: RegExp,
	fn: (m: RegExpExecArray, before: string, after: string) => Emphasis | undefined,
): string => {
	const units = text.split('');
	const used = new Array<boolean>(text.length).fill(false);
	const encodable = (i: number): boolean => {
		const c = text[i];
		if (c === undefined || used[i] || /\s/.test(c)) return false;
		const code = c.charCodeAt(0);
		return !(code >= 0xd800 && code <= 0xf8ff);
	};
	const ref = (i: number) => `&#${text.charCodeAt(i)};`;
	for (const m of text.matchAll(re)) {
		const at = m.index!;
		const end = at + m[0].length;
		const e = fn(m as RegExpExecArray, text[at - 1] ?? '', text[end] ?? '');
		if (!e) continue;
		const wantB = e.encBefore && at > 0;
		const wantA = e.encAfter && end < text.length;
		// A neighbour that does not flank at the text's edge cannot happen (edge is whitespace-like); if it cannot be encoded: plain.
		const okB = !wantB || encodable(at - 1);
		const okA = !wantA || encodable(end);
		const ok = okB && okA;
		// A pair that cannot be encoded keeps the typed marks, escaped: both clients then show the stars (or underscores) as typed.
		units[at] = ok ? e.marked : `${literal(m[1])}${m[2]}${literal(m[1])}`;
		for (let k = at + 1; k < end; k++) units[k] = '';
		for (let k = at; k < end; k++) used[k] = true;
		if (ok) {
			if (wantB) {
				units[at - 1] = ref(at - 1);
				used[at - 1] = true;
			}
			if (wantA) {
				units[end] = ref(end);
				used[end] = true;
			}
		}
	}
	return units.join('');
};

/**
 * A star or underscore RC leaves literal (no pair on its line) that CommonMark could still pair with another one on a later
 * line of the same paragraph would emphasize across the newline: those are backslash-escaped. A mark that only opens, or only
 * closes, with nothing to pair with is sent as typed: the backslash would turn Element's send into its plain path, which loses
 * the newline (S4).
 */
const escapeStrays = (text: string): string =>
	text
		.split(/\n{2,}/)
		.map((para) => {
			let out = para;
			for (const mark of ['*', '_'] as const) {
				const re = mark === '*' ? /(?<![\\*])\*+/g : /(?<![\\\w])_+(?![\w])|(?<![\\])_+(?=\w)|(?<=\w)_+(?![\w])/g;
				const found: { at: number; len: number; line: number; open: boolean; close: boolean }[] = [];
				for (const m of out.matchAll(re)) {
					const at = m.index!;
					const prev = out[at - 1] ?? '';
					const next = out[at + m[0].length] ?? '';
					// Could open (not before a space) or close (not after one).
					if (isWs(next) && isWs(prev)) continue;
					if (mark === '_' && /\w/.test(prev) && /\w/.test(next)) continue;
					found.push({
						at,
						len: m[0].length,
						line: out.slice(0, at).split('\n').length,
						open: opens(mark, prev, next),
						close: closes(mark, prev, next),
					});
				}
				if (found.length < 2 || new Set(found.map((f) => f.line)).size < 2) continue;
				// Only a mark that has a partner (an opener before a closer) can be re-paired by CommonMark.
				const pairable = found.filter(
					(f, i) => (f.open && found.slice(i + 1).some((g) => g.close)) || (f.close && found.slice(0, i).some((g) => g.open)),
				);
				for (const f of pairable.reverse()) {
					let piece = out.slice(f.at, f.at + f.len);
					piece = [...piece].map((c) => `\\${c}`).join('');
					out = out.slice(0, f.at) + piece + out.slice(f.at + f.len);
				}
			}
			return out;
		})
		.join('\n\n');

/** Rocket.Chat's composer text as the CommonMark the host sends with `markdown: true`. */
export const toCommonMark = (text: string): string => {
	const p = protect(text);
	let t = p.text.replace(MERGE_BOLD, '$1$2$3$1').replace(MERGE_STRIKE, '$1$2$3$1').replace(MERGE_ITALIC, '$1$2$3$1');
	t = t.replace(RC_STRIKE, (whole, _m, inner: string) => {
		const core = inner.trim();
		if (!core) return whole;
		const lead = inner.slice(0, inner.length - inner.trimStart().length);
		return `${lead}<del>${core}</del>${inner.slice(inner.trimEnd().length)}`;
	});
	t = mapPairs(t, RC_BOLD, (m, before, after) => emphasis('*', m[2], before, after, p.edge));
	t = mapPairs(t, RC_ITALIC, (m, before, after) => {
		// RC's `_x_` is text before a letter, `__x__` before a letter or digit (grammar.pegjs).
		if (m[1].length === 1 ? /[A-Za-z]/.test(after) : /[A-Za-z0-9]/.test(after)) return undefined;
		return emphasis('_', m[2], before, after, p.edge);
	});
	t = escapeStrays(t).replace(/\uf8f0/g, '*').replace(/\uf8f1/g, '_');
	return p.restore(t, true);
};

// A numeric character reference in a FORMATTED body (Element has formatted HTML for it): Element's CommonMark renderer shows
// the character of every numeric reference, so RC's row decodes each one whose code point is a Unicode letter, number or
// mark (`[\p{L}\p{N}\p{M}]`), wherever it stands (fix6; the send map writes letters, digits and combining marks as references).
// Every other reference stays as received (punctuation such as `&#91;` `&#60;`, the private-use HOLE range, invalid code
// points): decoded it would build a link, a tag or a mention in RC's row. A PLAIN body (no formatted HTML) is shown by
// Element exactly as stored, so nothing is decoded there (`@admi&#110;_` must not become a mention pill of another user).
const decodeRefs = (text: string): string =>
	text.replace(/&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (whole, dec: string | undefined, hex: string | undefined) => {
		const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
		if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= HOLE && cp <= 0xf8ff)) return whole;
		const ch = String.fromCodePoint(cp);
		return /^[\p{L}\p{N}\p{M}]$/u.test(ch) ? ch : whole;
	});

/** A received message body as Rocket.Chat's parser should read it (both dialects agree on everything not mapped here). */
export const fromCommonMark = (body: string, opts: { formatted: boolean } = { formatted: false }): string => {
	const p = protect(body);
	return p.restore(untag(markTags(opts.formatted ? decodeRefs(p.text) : p.text).replace(CM_STRONG_US, '**$1**').replace(CM_ITALIC, '_$1_')), false);
};
