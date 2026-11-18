// Bundler swap of Rocket.Chat's UserCardProvider (patch reason class "D41 wire", interim, M14 K4): a click on a message's sender
// (avatar or name, in a room message, a thread message, a system message or a mention) opens Element's own user info of that
// member in the host panel slot (bridge.openUserInfo) instead of Rocket.Chat's popover card, which has no server to ask here.
// The username of a sender is the full Matrix user id (map.ts), so it is the host's user id as it stands. What is no Matrix user
// id (a mention of a bare name) opens nothing. A refused call toasts and leaves what was open as it was. The kit keeps no
// card state: the provider only supplies the context value Rocket.Chat's message components read.
import { UserCardContext } from '@rocket.chat/ui-contexts';
import { dispatchToastMessage } from 'rc/client/lib/toast';
import { useRoom } from 'rc/client/views/room/contexts/RoomContext';
import { useMemo, useRef } from 'react';
import type { ReactNode, UIEvent } from 'react';

import { getSource } from './adapter/bridge.ts';

export type UserCardProviderProps = { children: ReactNode };

/** A Matrix user id: `@localpart:server`. */
const isMxid = (username: string): boolean => /^@[^:\s]+:\S+$/.test(username);

const noop = () => undefined;

const UserCardProvider = ({ children }: UserCardProviderProps) => {
	const room = useRoom();
	const rid = room._id;
	const triggerRef = useRef<Element | null>(null);

	const value = useMemo(
		() => ({
			openUserCard: (_e: UIEvent, username: string) => {
				if (!isMxid(username)) return;
				getSource()
					.openUserInfo(rid, username)
					.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: error }));
			},
			closeUserCard: noop,
			triggerProps: {},
			triggerRef,
			state: { isOpen: false, setOpen: noop, open: noop, close: noop, toggle: noop },
		}),
		[rid],
	);

	return <UserCardContext.Provider value={value}>{children}</UserCardContext.Provider>;
};

export default UserCardProvider;
