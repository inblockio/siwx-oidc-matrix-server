// Bundler swap of Rocket.Chat's `useVideoConfOpenCall` (patch reason class "D26 hand-off window"; ONE commit of the lane, so it can
// be dropped on its own). Same signature as the original hook. Rocket.Chat 8.9 names its call pop-out only for its own in-product
// conference page (`VideoConf_Conference_Window_Enabled`, an Enterprise setting whose page runs inside the Rocket.Chat app: not
// possible in this view); for an external provider's address it opens a new tab for every Join. The call here is aqua-meet in
// its own window, so the address opens in Rocket.Chat's own window name (the original's `rocketchat-conference`) and a second
// Join for the room the window already shows only focuses it: no second tab.
import { useSetModal } from '@rocket.chat/ui-contexts';
import { useCallback } from 'react';
import VideoConfBlockModal from 'rc/client/views/room/contextualBar/VideoConference/VideoConfBlockModal';
import { createCallWindowOpener, isBlocked } from './call-window-open.ts';

const POPOUT_WIDTH = 1280;
const POPOUT_HEIGHT = 800;

const popoutFeatures = (): string => {
	const width = Math.min(POPOUT_WIDTH, window.screen.availWidth);
	const height = Math.min(POPOUT_HEIGHT, window.screen.availHeight);
	const left = Math.round((window.screen.availWidth - width) / 2);
	const top = Math.round((window.screen.availHeight - height) / 2);
	return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
};

const asCallUrl = (candidate: string): URL | undefined => {
	try {
		const url = new URL(candidate);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
	} catch {
		return undefined;
	}
};

/** The named window on the address: focused when it already shows that address, else opened or navigated there (opener cut). */
const openCallWindow = createCallWindowOpener({ open: (url, name, features) => window.open(url, name, features) }, popoutFeatures);

export const useVideoConfOpenCall = () => {
	const setModal = useSetModal();

	return useCallback(
		(callUrl: string, _providerName?: string): Window | null | undefined => {
			const desktopApp = (window as unknown as { RocketChatDesktop?: { openInternalVideoChatWindow?: (url: string, opts: unknown) => void } }).RocketChatDesktop;
			if (desktopApp?.openInternalVideoChatWindow) {
				desktopApp.openInternalVideoChatWindow(callUrl, { providerName: _providerName });
				return undefined;
			}
			// Not a web address: nothing to open (and nothing to run in a window we opened).
			if (!asCallUrl(callUrl)) return null;
			const target = openCallWindow(callUrl);
			if (!isBlocked(target)) return target;
			setModal(<VideoConfBlockModal onClose={(): void => setModal(null)} onConfirm={() => void openCallWindow(callUrl)} />);
			return null;
		},
		[setModal],
	);
};
