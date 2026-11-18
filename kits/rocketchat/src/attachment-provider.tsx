// Replaces Rocket.Chat's `client/providers/AttachmentProvider.tsx` (bundler swap): every media URL the bridge hands over is
// absolute (a homeserver URL served through Element's service worker, or a blob URL of Element's window), so it is used
// as it is; Rocket.Chat's getURL would treat a `blob:` URL as a path of the site. Element's media-visibility setting
// already decided what is hidden (such media carries no URL), so loading is automatic.
import type { AttachmentContextValue } from '@rocket.chat/ui-contexts';
import { AttachmentContext } from '@rocket.chat/ui-contexts';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

const AttachmentProvider = ({ children, width = 360, height = 360 }: { children?: ReactNode; width?: number; height?: number }) => {
	const value: AttachmentContextValue = useMemo(
		() => ({ getURL: (url: string): string => url, collapsedByDefault: false, autoLoadEmbedMedias: true, dimensions: { width, height } }),
		[width, height],
	);
	return <AttachmentContext.Provider value={value}>{children}</AttachmentContext.Provider>;
};

export default AttachmentProvider;
