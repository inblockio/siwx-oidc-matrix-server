// Bundler swap of Rocket.Chat's QuoteAttachment that WRAPS it (0 source patches; patch reason class "D40 quote", M9 Q1):
// in a reply the quote is Rocket.Chat's quote attachment, whose only jump is a small icon link. The whole quote is
// clickable here: a pointer, and a click is the same jump as the icon (`?msg=<id>` on the room, the id from `message_link`).
// A drag-select is no click (the text stays selectable), and a click on a link inside the quote keeps its own meaning.
import { memo, useRef, type MouseEvent } from 'react';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { QuoteAttachment as OriginalQuoteAttachment } from 'rc/client/components/message/content/attachments/QuoteAttachment.tsx?kit-original';

import { endsSelection } from './quote-click.ts';
import { setMessageJumpQueryStringParameter } from './jump-param.ts';

type Props = Parameters<typeof OriginalQuoteAttachment>[0];

/** The message id a quote's `message_link` names (`?msg=<id>`, encoded twice, see `jumpParam`), or undefined. */
export const quotedId = (messageLink: string | undefined): string | undefined => {
	if (!messageLink) return undefined;
	try {
		const raw = new URL(messageLink, 'http://kit.invalid').searchParams.get('msg');
		return raw ? decodeURIComponent(raw) : undefined;
	} catch {
		return undefined;
	}
};

export const QuoteAttachment = (props: Props) => {
	const down = useRef<{ x: number; y: number } | null>(null);
	const id = quotedId(props.attachment.message_link);
	if (!id) return <OriginalQuoteAttachment {...props} />;
	const jump = (e: MouseEvent<HTMLDivElement>) => {
		const target = e.target as Element;
		// A link in the quote (the jump icon, the time, an author link) does its own thing; only quotes in a message row jump
		// (the composer's reply preview and the forward/pin modals show quotes too).
		if (target.closest('a') || !target.closest('.rcx-message')) return;
		// Not the selection text (a selection left from before does not matter): the press-to-release movement decides.
		if (endsSelection(down.current, { x: e.clientX, y: e.clientY, detail: e.detail })) return;
		void setMessageJumpQueryStringParameter(id);
	};
	// `display: contents`: no box of its own, the quote lays out as before; the pointer is inherited by the quote and its text.
	return (
		<div data-kit-quote-jump='' style={{ display: 'contents', cursor: 'pointer' }} onMouseDown={(e) => (down.current = { x: e.clientX, y: e.clientY })} onClick={jump}>
			<OriginalQuoteAttachment {...props} />
		</div>
	);
};

export default memo(QuoteAttachment);
