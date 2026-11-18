// Replaces Rocket.Chat's `client/providers/AvatarUrlProvider.tsx` (bundler swap): avatars come from the bridge (the
// host's view-model avatar URLs), or an inline initial avatar; never a request to a Rocket.Chat /avatar/ route.
import { AvatarUrlContext } from '@rocket.chat/ui-contexts';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { getSource } from './adapter/bridge.ts';

const AvatarUrlProvider = ({ children }: { children?: ReactNode }) => {
	const value = useMemo(() => {
		const getUserPathAvatar = (...args: any[]): string => {
			const [first] = args;
			const key = typeof first === 'string' ? first : (first?.userId ?? first?.username ?? '');
			return getSource().avatar(String(key));
		};
		return {
			getUserPathAvatar,
			getRoomPathAvatar: (room: any): string => getSource().avatar(String(room?._id ?? room?.rid ?? '')),
		};
	}, []);
	return <AvatarUrlContext.Provider value={value as any}>{children}</AvatarUrlContext.Provider>;
};

export default AvatarUrlProvider;
