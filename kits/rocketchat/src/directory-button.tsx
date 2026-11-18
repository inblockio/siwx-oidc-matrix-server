// Bundler swap of Rocket.Chat's Directory navbar button (patch reason class "D41 wire"): the button opens Element's own
// Directory (Spotlight, rooms filter) over the view through the bridge instead of Rocket.Chat's /directory page. The room
// the user picks opens here (a peeked, not joined one on Rocket.Chat's "not joined" screen). Callers pass `title`, so the
// button keeps its name ("Directory").
import { NavBarItem } from '@rocket.chat/fuselage';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import type { HTMLAttributes } from 'react';

import { getSource } from './adapter/bridge.ts';
import { type DirectoryOptions, runDirectory } from './directory-flow.ts';
import { openPreviewRoom, openRoom } from './room-opener.ts';

export type NavBarItemDirectoryPageProps = Omit<HTMLAttributes<HTMLElement>, 'is'>;

/** Opens Element's Directory; a failure is the kit's error toast (as in create-new-items.ts). */
export const useOpenDirectory = () => {
	const dispatchToastMessage = useToastMessageDispatch();
	return (opts?: DirectoryOptions): Promise<void> =>
		runDirectory(
			{
				directory: (o) => getSource().openDirectory(o),
				roomKnown: (rid) => !!getSource().room(rid),
				openRoom: (rid) => openRoom(rid),
				openPreview: openPreviewRoom,
				fail: (error) => dispatchToastMessage({ type: 'error', message: error }),
			},
			opts,
		);
};

const NavBarItemDirectoryPage = (props: NavBarItemDirectoryPageProps) => {
	const openDirectory = useOpenDirectory();
	return <NavBarItem {...props} icon='notebook-hashtag' onClick={() => void openDirectory()} />;
};

export default NavBarItemDirectoryPage;
