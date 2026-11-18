// Bundler swap of Rocket.Chat's composer "Upload file" action (patch reason class "D17 single confirmation"): the action
// asks the host to upload through Element's own flow (its file picker, its upload confirmation, its upload and error
// dialogs), so Rocket.Chat's picker and its FileUploadModal are skipped and the user confirms once. Same signature as the
// original hook. The host's picker opens inside this click (the call is the first thing the click handler does).
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';
import { useSetting, useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { useTranslation } from 'react-i18next';
import { useRoom } from 'rc/client/views/room/contexts/RoomContext';

import { getSource } from './adapter/bridge.ts';

export const useFileUploadAction = (disabled: boolean): GenericMenuItemProps => {
	const { t } = useTranslation();
	const fileUploadEnabled = useSetting('FileUpload_Enabled', true);
	const room = useRoom();
	const dispatchToastMessage = useToastMessageDispatch();

	// No `await` before the host call: the picker needs the user's click. A cancelled picker or confirm is not an error. A new
	// chat has no room yet: the host refuses before any dialog ("send a message first") and the error shows as Rocket.Chat's
	// own toast; the user stays in the chat.
	const handleUpload = () => {
		getSource()
			.upload(room._id)
			.catch((error) => dispatchToastMessage({ type: 'error', message: error }));
	};

	return {
		id: 'file-upload',
		content: t('Upload_file'),
		icon: 'clip',
		onClick: handleUpload,
		disabled: !fileUploadEnabled || disabled,
	};
};
