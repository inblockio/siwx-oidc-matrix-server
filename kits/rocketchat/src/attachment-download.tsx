// Replaces Rocket.Chat's `components/message/content/attachments/structure/AttachmentDownloadBase.tsx` (bundler swap):
// the download control links the bridge's media URL as it is. Rocket.Chat appends `?download` for its own file route;
// on a `blob:` URL (decrypted media) that is another URL that resolves to nothing, and a homeserver URL already has a
// query (`?allow_redirect=true`). A file only Element can hand over (an encrypted one) carries `evw-download:` as its href:
// the click is answered by `download-link.ts`, not by the browser.
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import Action from 'rc/client/components/message/content/Action';

export type AttachmentDownloadBaseProps = Omit<ComponentProps<typeof Action>, 'icon'> & { title?: string | undefined; href: string };

const AttachmentDownloadBase = ({ title, href, disabled, ...props }: AttachmentDownloadBaseProps) => {
	const { t } = useTranslation();

	return (
		<Action
			icon='cloud-arrow-down'
			href={href}
			title={disabled ? t('Download_Disabled') : t('Download')}
			is='a'
			target='_blank'
			rel='noopener noreferrer'
			download={title}
			disabled={disabled}
			{...props}
		/>
	);
};

export default AttachmentDownloadBase;
