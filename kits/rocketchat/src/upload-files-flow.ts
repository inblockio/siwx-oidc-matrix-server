// Bundler swap of Rocket.Chat's `chat.flows.uploadFiles` (patch reason class "D17 single confirmation"): every caller of the
// flow (the room's drop zone, the composer's paste handler, the audio and video recorders, the WebDAV picker) ends here, so
// the files go to the host's upload (`bridge.upload(roomId, files)`) and Element's own upload confirmation is the one
// confirmation; Rocket.Chat's composer upload store and its FileUploadModal are skipped. Same signature as the original
// flow. One call carries all the files of one drop or paste. A dismissed confirm is not an error; a refused upload shows
// Element's error dialog and Rocket.Chat's error toast and leaves no row.
import { dispatchToastMessage } from 'rc/client/lib/toast';
import type { ChatAPI } from 'rc/client/lib/chats/ChatAPI';

import { getSource } from './adapter/bridge.ts';

export const uploadFiles = async (
	chat: ChatAPI,
	{ files, resetFileInput }: { files: readonly File[]; resetFileInput?: () => void },
): Promise<void> => {
	const room = await chat.data.getRoom();
	resetFileInput?.();
	try {
		if (files.length > 0) await getSource().upload(room._id, [...files]);
	} catch (error) {
		dispatchToastMessage({ type: 'error', message: error });
	} finally {
		chat.composer?.focus();
	}
};
