// Bundler swap of Rocket.Chat's setMessageJumpQueryStringParameter (0 source patches, F4): the original reads
// `new URL(window.location.href).pathname`, a member expression the `location` swap does not reach, so jump-to-message
// and jump-to-unread navigated to the kit document's path (/kits/rocketchat/index.html) and left the room. Same logic,
// on the virtual location (Rocket.Chat's path from the hash, reload.ts); the id is encoded for Rocket.Chat's double
// decode of `msg` (jumpParam, kit inc1 F4).
import type { IMessage } from '@rocket.chat/core-typings';
import type { LocationPathname } from '@rocket.chat/ui-contexts';
import { router } from 'rc/client/providers/RouterProvider';

import { jumpParam } from './adapter/map.ts';
import { location } from './reload.ts';

export const setMessageJumpQueryStringParameter = async (msg: IMessage['_id'] | null, context?: 'jumpToUnread') => {
	const { msg: _msg, jumpContext: _jumpContext, ...search } = router.getSearchParameters();
	const locationPathname = location.pathname as LocationPathname;

	router.navigate(
		{
			pathname: locationPathname,
			search: msg ? { ...search, msg: jumpParam(msg), ...(context && { jumpContext: context }) } : search,
		},
		{ replace: true },
	);
};
