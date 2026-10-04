# Copy Markdown: the algorithm

"Copy Markdown" (Element Web patch entry 11, issue #24) turns one Matrix room message into
Markdown. This document is the language-neutral contract, so that every implementation gives
byte-identical output: the Element Web patch (TypeScript) and any port an agent uses through a
Matrix SDK. [`vectors.json`](vectors.json) is the conformance suite; a conforming
implementation reproduces every vector byte for byte.

The reference implementation is in the vendored patch
[`patches/element-web/copy-markdown.patch`](../../patches/element-web/copy-markdown.patch):
`apps/web/src/utils/eventToMarkdown.ts` (the steps, the safety predicates, the converter) and
`apps/web/src/utils/markdownCanon.ts` (the canonical model). The patch carries a copy of the
vectors (`apps/web/src/utils/eventToMarkdown.vectors.json`); CI checks that it is
byte-identical to the one here (`scripts/check-copy-markdown-vectors.py`).

## Guarantees

- **G1 Raw data only.** The output is a pure function of the event's own content: `msgtype`,
  `body`, `format`, `formatted_body` (for an edited message, those of the latest
  `m.new_content`), plus one flag, whether the displayed content carries a reply fallback
  (the event is a reply, `m.relates_to["m.in_reply_to"]`, and its content is not a
  replacement: an edit's `m.new_content` carries no fallback). It never depends on the
  copying client: no settings, no renderer of the copying client, no locale, no time.
- **G2 The sender's source when it is provable.** When the `body` is provably the Markdown
  source of what is displayed, the copy is the `body`, whichever client or SDK sent it.
- **G3 Never unsafe.** The copy never contains raw HTML, a link whose scheme is not permitted,
  or an image that is not `mxc:`, read as CommonMark and read as GFM.
- **G4 Otherwise, the converter.** A message whose source cannot be proven is converted from
  its HTML (`formatted_body`) to Markdown by the converter, which copies what Element displays.

## Steps

1. **Reply fallback** (only when the flag is set). `body`: drop the leading lines that start
   with `"> "`, then one empty line if present. `formatted_body`: handled by the canonical
   model (an `mx-reply` element is removed there, under strict conditions).
2. `S` = the `body` with trailing ASCII whitespace removed.
3. **Plain message** (no usable HTML: `format` is not `org.matrix.custom.html`, or
   `formatted_body` is not a string or is the empty string, as Element decides; a
   whitespace-only one is HTML that displays nothing; for a reply, a `formatted_body` that is only
   the fallback counts as none): if `S` is not empty and `safe(S)`, the copy
   is `S`, because a plain body is its own source. Otherwise the copy is the body with every
   Markdown-significant character escaped (the converter's plain path).
4. **HTML message.** Candidates: `S`, then `S` with mentions spliced in (below). The first
   candidate `X` with `canonMd(X) == canonHtml(formatted_body)` and `safe(X)` is the copy.
5. Otherwise the copy is the converter's output for `formatted_body`.

## Canonical model

Both sides are mapped to one tree and compared by structural equality. The model keeps
everything that changes what a reader sees (text, links and their targets, images and their
sources, code, block structure) and drops what only differs between renderers.

Either side can instead be **opaque**: no tree, which never compares equal, so the message
takes the converter. The HTML side is accepted only when it is plain Markdown-renderer HTML,
because what Element displays is the output of its HTML sanitiser (another tokenizer and an
allow-list), and the two agree only on such HTML. Markdown renderers never emit what is
excluded below, so no legitimate message is lost, and a crafted one cannot make the copy carry
text, links or code that the reader does not see.

- Blocks: paragraph, heading (level), code block (language, text), quote, list (ordered,
  start), item (task: none, open, done), thematic break, table (header cells, rows), raw HTML
  block, maths block, details.
- Inlines: text, break, emphasis, strong, code, link (target), image (source, alt text), raw
  HTML, maths.

**From Markdown** (`canonMd`): parse with plain CommonMark 0.31, no extensions. Soft and hard
line breaks both become a break.

**From HTML** (`canonHtml`): the rule does not use a general HTML parser. It reads
`formatted_body` with its own strict tokenizer and tree builder, the same in every
implementation; input outside this grammar is opaque. On input inside it, every HTML5 parser,
Element's sanitiser and a port build the same tree, so no parser difference (error recovery,
reconstructed formatting elements, raw-text elements, comments, CDATA) can make the copy differ
from what is displayed.

- **Tokens.** Text is any characters except `<`. Every `&` starts one of `&amp; &lt; &gt;
  &quot; &apos; &#39;`, a decimal (`&#` 1-7 digits `;`) or hex (`&#x` 1-6 hex digits `;`)
  reference to a valid scalar value that is not U+0000, a surrogate or a C1 control; any other
  `&` is opaque. U+0000, `<!` and `<?` are opaque. A tag is `<NAME ATTRS>` or `</NAME>`, NAME
  ASCII (`[A-Za-z][A-Za-z0-9-]*`, compared lowercased), attributes separated by ASCII
  whitespace with quoted values only; a duplicate attribute or any `<` that does not start a
  well-formed tag is opaque. CRLF and CR become LF.
- **Elements** (allow-list, anything else opaque, including `span`, `div`, `details`, `input`,
  `u`, `sub`, `sup`, `font`, so maths and spoilers): blocks `p h1-h6 pre blockquote ul ol li hr
  table thead tbody tfoot tr th td`, inlines `strong b em i del s strike code a img br`.
- **Attributes** (allow-list, anything else opaque): `a href`, `img src alt`, `ol start`,
  `code class`, `th`/`td` `style align`. A `title` is opaque (hover text the copy would carry
  but the reader does not see), as is a link or image title on the Markdown side. An `a` with
  an empty or no `href` is plain text, as Element shows it.
- **Nesting.** `br`, `hr` and `img` are void; every other element is closed by its own end tag,
  in order (an end tag must match the innermost open element, and nothing may stay open). At
  most 40 open elements (Element's sanitiser drops content beyond 50).
- **Content model.** `p`, headings, `th` and `td` hold inline content only; `ul` and `ol` hold
  only `li`; tables hold only their row groups and rows, a `thead` never after a row and a
  `tfoot` never before one; `pre` holds text or one `code`; `code` holds text only; inline
  elements hold inline content only, and a link never holds a link. The document, `blockquote`
  and `li` hold blocks or inline content; inline content directly inside them is a paragraph.
  One LF directly after `<pre>` is dropped, as HTML5 does.
- **Reply rule.** With the reply-fallback flag set, the tree holds exactly one `mx-reply`, with
  no attributes, as the first non-whitespace child; it is removed. Any other shape, and any
  `mx-reply` without the flag, is opaque.
- **List start.** `ol[start]` is 1 when absent, else 1 to 9 ASCII digits.
- `p`, headings, `pre`, `blockquote`, `ul`, `ol`, `li`, `hr` and `table` map to their blocks;
  `br`, `strong`/`b`, `em`/`i`, `code`, `a[href]` and `img` to their inlines; `del`/`s`/`strike`
  are lowered (below).

**Lowering and normalisation**, the same on both sides:

1. Strikethrough becomes text: `<del>x</del>` compares equal to the literal `~~x~~` that
   CommonMark leaves as text.
2. Adjacent text is merged.
3. **Tables in paragraphs** follow the GFM table rules, applied after inline parsing: a line
   with a pipe followed by a delimiter row with the same cell count starts a table that runs
   to the end of the paragraph. So a table that one client rendered as `<table>` and another
   displayed as pipe text compare equal. Rows are padded with empty cells to the header's
   count. Where the post-inline split could differ from GFM's split of the source line, the
   table is opaque: a pipe inside code, emphasis or a link; a source line whose count of
   unescaped `|` differs from the pipes in its text (escaped and entity pipes); a row with more
   cells than the header; a row line that would start a block in GFM (a list marker, `>`, a
   heading, a fence, a thematic break, `<`, or 4 or more columns of indentation, relative to
   the delimiter line inside a list item).
4. **Task items**: an item starting with `[ ]`, `[x]` or `[X]` (or a checkbox input) is a task.
5. **Whitespace**: runs of ASCII whitespace (space, tab, LF, CR, FF) become one space;
   spaces around a break and at the ends of a block are dropped; trailing breaks are dropped.
   Tight and loose lists compare equal. Every trim, blank test and character class in the
   algorithm uses ASCII whitespace and ASCII digits only (a port must not use a Unicode
   whitespace or digit class).
6. **Links**: on both sides `[` becomes `%5B`, `]` becomes `%5D` and a `%` not followed by two
   hex digits becomes `%25` (what commonmark.js does to a destination, so ports built on other
   parsers agree); then targets are normalised per RFC 3986 section 6.2.2: bytes outside the
   unreserved and reserved sets are percent-encoded as UTF-8 with uppercase hex, existing
   escapes are uppercased, and an escape is decoded only when it encodes an unreserved
   character. Reserved characters are never decoded. On the HTML side a target holding `\`,
   a tab, LF or CR, or starting with two of `/` and `\`, is opaque (browsers read those
   differently); on the Markdown side an empty destination is opaque.

## Mentions

A client writes a mention into `formatted_body` as a link to `https://matrix.to/#/@user:server`
(or a room), but into `body` as the display name only, so the plain body never matches. The
splice candidate replaces, in order, each mention's display name in `S` with
`[Name](https://matrix.to/#/...)` (the form Element itself writes). It is accepted only through
the same strict comparison, so a wrong guess can only cause a fallback, never a wrong copy.

## Safety

`safe(X)` holds when:

- `X` parsed as CommonMark defines no link reference definition (a GFM renderer can resolve
  one inside a table cell that CommonMark saw as code, and a definition's text is never
  displayed), and holds no raw HTML (inline or block), no link whose target's scheme
  is outside the permitted list, and no image whose source is not `mxc://`. A scheme is read
  after removing characters up to U+0020 and HTML comments, as a browser's URL parser and
  Element's sanitiser do; a target without a scheme is permitted unless it starts with two
  slashes or backslashes. Permitted schemes (Element's `PERMITTED_URL_SCHEMES`): `bitcoin`,
  `file`, `ftp`, `ftps`, `geo`, `http`, `https`, `im`, `magnet`, `mailto`, `matrix`, `news`,
  `openpgp4fpr`, `sip`, `sms`, `smsto`, `tel`, `urn`, `xmpp`.
- `X` has no GFM delimiter line outside code blocks, or no line outside code blocks containing
  `]:` (after a table, GFM can read a definition where CommonMark reads paragraph text);
- `X` contains at most 1000 `[` (commonmark.js parses some bracket runs in quadratic time, and
  the check parses the raw body; a longer one is not a source candidate);
- every line outside a code block, cut into cells the way GFM splits a table row (a backslash
  escapes the next character, an unescaped `|` splits, `\|` is unescaped afterwards), has every
  cell safe on its own, parsed as inline content. A GFM renderer splits a row before it reads
  any inline syntax, so it can cut open a code span that CommonMark saw and expose the HTML in
  it.

## Conformance vectors

[`vectors.json`](vectors.json): `{ version, generated_with, vectors: [ { id, note, content,
strip_reply_fallback, expected, path } ] }`. `content` is the raw event content, `expected` the exact
output, and `path` which step produced it (`source`, `source+mentions`, `converter`,
`escaped`). The HTML in the vectors was produced by real senders: Element Web's own send path
and ruma's `text_markdown` (the Matrix Rust SDK; versions in `generated_with`). All content is
synthetic. Element's suite runs every vector in its test DOM and, through
`apps/web/vitest.browser.copy-md.config.ts`, in Chromium.

## Porting notes

A port parses Markdown with a CommonMark 0.31 parser with no extensions and HTML with an
HTML5 parser with scripting disabled, and must reproduce these details of the reference,
each pinned by vectors:

- commonmark.js percent-encodes link destinations before the comparison sees them, so `|`,
  `[`, `]` and a bare `%` in a destination arrive encoded (`%7C` counts as a pipe in a table
  line).
- commonmark.js trims non-ASCII whitespace and U+FEFF at line edges where other parsers do
  not; a Markdown line edge holding such a character is opaque.
- An `li` outside a list is opaque.

## Known limits

Each falls back to the converter (G4), never to a wrong copy:

- a table whose source escapes a pipe or holds a pipe inside a code span (GFM splits those
  differently from the post-inline cell split);
- maths, spoilers and any HTML outside the allow-list (opaque by construction);
- single-tilde strikethrough (`~a~`);
- raw HTML that the sender's renderer passed through (never copied as source, G3);
- Element renderer quirks with no portable equivalent: emphasis inside a bare URL, a loose item
  in a message that is one list, plain text with a backslash escape across several lines.

The converter (G4) parses `formatted_body` as HTML5, not with the sanitiser's tokenizer, so for
crafted HTML (comments, CDATA, raw-text elements) its output can differ from what Element
displays; that predates this algorithm and is tracked separately.
