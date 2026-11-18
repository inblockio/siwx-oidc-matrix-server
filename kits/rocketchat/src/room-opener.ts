// Opens a room of the kit in Rocket.Chat's router (after a created or joined room, or the real room of a new chat).
import { roomCoordinator } from 'rc/client/lib/rooms/roomCoordinator';

import { getSource } from './adapter/bridge.ts';
import { openPreview } from './adapter/sdk.ts';

// `replace`: the route being left is a stale one (an address route of a room that has since been joined), not history.
export const openRoom = (rid: string, replace = false) => {
	const room = getSource().room(rid);
	if (!room) return;
	roomCoordinator.openRouteLink(room.t, { rid: room._id, name: room.name }, undefined, { replace });
};

// A room the user only previews (the Directory's `peek` pick): Rocket.Chat's "not joined" screen with its Join button
// (sdk.ts `openPreview` registers the id as a looked-up room; the screen titles it by the id, the bridge gives no name).
export const openPreviewRoom = (roomId: string) => {
	const { rid, name } = openPreview(roomId);
	roomCoordinator.openRouteLink('c', { rid, name });
};
