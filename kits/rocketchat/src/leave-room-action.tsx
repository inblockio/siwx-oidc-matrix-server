// Bundler swap of Rocket.Chat's room menu "Leave" (patch reason class "D17 single confirmation"): the action asks Element's
// own leave confirm (the host's view-model action) and Rocket.Chat's warning modal is skipped, so the user confirms once.
// Same signature as the original hook; the room closes in Rocket.Chat when Element says the user left.
import type { RoomType } from '@rocket.chat/core-typings';
import { useStableCallback } from '@rocket.chat/fuselage-hooks';
import { useRouter, useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { LegacyRoomManager } from 'rc/client/lib/LegacyRoomManager';

import { getSource } from './adapter/bridge.ts';

type LeaveRoomProps = { rid: string; type: RoomType; name: string; roomOpen?: boolean };

export const useLeaveRoomAction = ({ rid, roomOpen }: LeaveRoomProps) => {
	const router = useRouter();
	const dispatchToastMessage = useToastMessageDispatch();
	return useStableCallback(async () => {
		try {
			const outcome = await getSource().leave(rid);
			if (outcome.status !== 'done') return; // the confirm said no
			if (roomOpen) router.navigate('/home');
			LegacyRoomManager.close(rid);
		} catch (error) {
			dispatchToastMessage({ type: 'error', message: error });
		}
	});
};
