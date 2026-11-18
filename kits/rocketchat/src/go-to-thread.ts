// Bundler swap of Rocket.Chat's useGoToThread hook (patch reason class "D37 thread panel"): the thread summary's "View thread"
// opens Element's own thread panel over the kit (bridge.openThread, the panel "Reply in thread" opens) instead of navigating to
// Rocket.Chat's thread tab route. Same signature; `msg` (a jump target) and `replace` (a router option) are ignored.
import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { dispatchToastMessage } from 'rc/client/lib/toast';

import { getSource } from './adapter/bridge.ts';
import { threadFailure } from './adapter/source.ts';

export const useGoToThread = (_options: { replace?: boolean } = {}) =>
	({ tmid }: { rid: IRoom['_id']; tmid: IMessage['_id']; msg?: IMessage['_id'] }): void => {
		getSource()
			.openThread(tmid)
			.catch((error: unknown) => dispatchToastMessage({ type: 'error', message: threadFailure(error) }));
	};
