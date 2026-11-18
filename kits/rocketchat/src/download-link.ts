// A file attachment whose bytes only Element can hand over (an encrypted file) links `evw-download:<room>/<event>` (map.ts
// `downloadHref`). Rocket.Chat renders that link twice, as its download control and as the title, both anchors that would
// open the scheme in a new tab. One capture listener answers a click on either with Element's own download
// (`bridge.download`, B7: Element decrypts the file and saves it with its own downloader, an error shows Element's
// dialog). The kit shows no success state of its own; a refusal of the call itself (no such event, nothing to download)
// is Rocket.Chat's error toast.
import { dispatchToastMessage } from 'rc/client/lib/toast';

import { parseDownloadHref } from './adapter/map.ts';
import { getSource } from './adapter/bridge.ts';

export const installDownloadLinks = (doc: Document): void => {
	doc.addEventListener(
		'click',
		(event) => {
			const anchor = (event.target as Element | null)?.closest?.('a[href]');
			const target = anchor && parseDownloadHref(anchor.getAttribute('href') ?? '');
			if (!target) return;
			event.preventDefault();
			event.stopPropagation();
			getSource()
				.download(target.rid, target.id)
				.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
		},
		true,
	);
};
