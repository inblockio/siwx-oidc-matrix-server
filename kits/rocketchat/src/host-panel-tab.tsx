// Bundler swap of Rocket.Chat's room-info, member-list, file-list, pinned-messages and message-search tab components (patch reason
// class "D39 header", interim): the header's info / title, Members, Files, Pinned and search entries open Element's own card
// in the host panel slot over the kit (bridge.openPanel) instead of Rocket.Chat's contextual bar. The tab is Rocket.Chat's own
// toolbox entry (its id says which card); the component asks the host for the card, closes the tab it was mounted by and renders
// nothing. Element's card owns its state, so the kit keeps none. A refused call toasts and leaves what was open as it was.
import { useRoomToolbox, useUserId } from '@rocket.chat/ui-contexts';
import { dispatchToastMessage } from 'rc/client/lib/toast';
import { useEffect, useRef } from 'react';

import { getSource } from './adapter/bridge.ts';
import type { ViewPanelCard } from './bridge-types.ts';
import { useRoom } from 'rc/client/views/room/contexts/RoomContext';
import RoomMembers from 'rc/client/views/room/contextualBar/RoomMembers';
import UserInfo from 'rc/client/views/room/contextualBar/UserInfo';

/** The card a Rocket.Chat toolbox tab id stands for; `username` is the context of an avatar card's "full profile". */
export const cardOfTab = (tabId: string | undefined, username?: string): ViewPanelCard | undefined => {
	switch (tabId) {
		case 'channel-settings':
			return 'info';
		case 'user-info':
			return username ? undefined : 'info';
		case 'members-list':
		case 'user-info-group':
			return username ? undefined : 'members';
		case 'uploaded-files-list':
			return 'files';
		case 'pinned-messages':
			return 'pinned';
		case 'rocket-search':
			return 'search';
		default:
			return undefined;
	}
};

const getUid = (uids: string[] | undefined, ownUserId: string | undefined) => {
	if (uids?.length === 1) return uids[0];
	return uids?.filter((uid) => uid !== ownUserId).shift() || uids?.[0];
};

const HostPanelTab = () => {
	const { tab, context: username, closeTab } = useRoomToolbox();
	const room = useRoom();
	const ownUserId = useUserId();
	const card = cardOfTab(tab?.id, typeof username === 'string' ? username : undefined);
	const opened = useRef(false);

	useEffect(() => {
		if (!card || opened.current) return;
		opened.current = true;
		getSource()
			.openPanel(room._id, card)
			.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
		closeTab();
	}, [card, room._id, closeTab]);

	// An avatar card's "full profile" names a user: Rocket.Chat's own profile stays (open item: Element's user card for it).
	if (!card && typeof username === 'string' && username) return <UserInfo username={username} onClose={closeTab} rid={room._id} />;
	if (!card && (tab?.id === 'members-list' || tab?.id === 'user-info-group')) return <RoomMembers rid={room._id} />;
	if (!card && tab?.id === 'user-info') return <UserInfo uid={getUid(room.uids, ownUserId)} onClose={closeTab} rid={room._id} />;
	return null;
};

export default HostPanelTab;
