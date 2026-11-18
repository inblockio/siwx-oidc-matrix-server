// Bundler swap of Rocket.Chat's `components/message/content/attachments/file/ImageAttachment.tsx` (patch reason class
// "D41 wire", M12 Z3): a copy of the original with ONE addition. An image Element hides (its media visibility, device-level
// as in Element) arrives from the adapter as an image attachment with no URL and the marker `kitHiddenMedia: { rid, eventId }`
// (map.ts `mediaAttachment`); M13 U2: a hidden VIDEO arrives the same way (Rocket.Chat's video attachment has no load control,
// and `bridge.showMedia` takes both). For it the image is not loaded, so Rocket.Chat's own `Load` box ("Click to load") shows, and a
// click is Element's reveal (`bridge.showMedia`, through the source). The kit keeps no state of its own: the box stays until
// the next timeline snapshot carries the image or video as an ordinary attachment (no marker), and a refused reveal is Rocket.Chat's
// error toast with the box still there. Without the marker this renders exactly as the original.
import type { ImageAttachmentProps } from '@rocket.chat/core-typings';
import { useMediaUrl } from '@rocket.chat/ui-contexts';

import { useLoadImage } from 'rc/client/components/message/content/attachments/file/hooks/useLoadImage';
import MarkdownText from 'rc/client/components/MarkdownText';
import MessageCollapsible from 'rc/client/components/message/MessageCollapsible';
import MessageContentBody from 'rc/client/components/message/MessageContentBody';
import AttachmentImage from 'rc/client/components/message/content/attachments/structure/AttachmentImage';
import { dispatchToastMessage } from 'rc/client/lib/toast';

import { getSource } from './adapter/bridge.ts';

export type HiddenMedia = { rid: string; eventId: string };

/** What the Load box does for a hidden image: Element's reveal; a refusal is the error toast (the box stays either way). */
export const revealHiddenMedia = (hidden: HiddenMedia): void => {
	getSource()
		.showMedia(hidden.rid, hidden.eventId)
		.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
};

const ImageAttachment = ({
	id,
	title,
	image_url: url,
	image_preview: imagePreview,
	image_size: size,
	image_dimensions: imageDimensions = {
		width: 368,
		height: 368,
	},
	image_alt: altText,
	description,
	descriptionMd,
	title_link: link,
	title_link_download: hasDownload,
	collapsed,
	kitHiddenMedia,
}: ImageAttachmentProps & { kitHiddenMedia?: HiddenMedia }) => {
	const [loadImage, setLoadImage] = useLoadImage();
	const getURL = useMediaUrl();
	const image = (load: boolean, setLoad: () => void) => (
		<AttachmentImage
			{...imageDimensions}
			loadImage={load}
			setLoadImage={setLoad}
			dataSrc={getURL(link || url)}
			src={getURL(url)}
			previewUrl={`data:image/png;base64,${imagePreview}`}
			id={id}
			alt={altText}
		/>
	);

	return (
		<>
			{descriptionMd ? <MessageContentBody md={descriptionMd} /> : <MarkdownText parseEmoji content={description} />}
			<MessageCollapsible title={title} hasDownload={hasDownload} link={getURL(link || url)} size={size} isCollapsed={collapsed}>
				{kitHiddenMedia ? (
					// `display: contents` keeps the layout of the original; the attribute is the capability row's selector (`media-reveal`).
					<div data-kit-media-reveal='' style={{ display: 'contents' }}>
						{image(false, () => revealHiddenMedia(kitHiddenMedia))}
					</div>
				) : (
					image(loadImage, setLoadImage)
				)}
			</MessageCollapsible>
		</>
	);
};

export default ImageAttachment;
