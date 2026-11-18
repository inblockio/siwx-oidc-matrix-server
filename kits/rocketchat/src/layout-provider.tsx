// Bundler swap of Rocket.Chat's LayoutProvider that WRAPS it (0 source patches; patch reason class "D39 hide"): Mentions,
// Starred messages and Discussions have no Element equivalent (D39), so they are removed, not marked N/A. D41 adds the
// message-menu and jump ids in the same list (`hide-actions.ts`). Rocket.Chat's own
// layout override does it: the `overrideUi` message the original provider listens for (`hideActions`), which the room
// toolbox, the message menu and the composer's more-actions menu filter by action id. The provider's listener is added in an
// effect of the original, which runs before this wrapper's effect; the message itself is delivered later still.
import { type ReactNode, useEffect } from 'react';
import type { LayoutProviderProps } from 'rc/client/providers/LayoutProvider.tsx?kit-original';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import LayoutProvider from 'rc/client/providers/LayoutProvider.tsx?kit-original';

import { HIDE_ACTIONS } from './hide-actions.ts';
export { HIDE_ACTIONS };

const KitLayoutProvider = ({ children }: LayoutProviderProps): ReactNode => {
	useEffect(() => {
		window.postMessage({ event: 'overrideUi', hideActions: HIDE_ACTIONS }, window.location.origin);
	}, []);
	return <LayoutProvider>{children}</LayoutProvider>;
};

export default KitLayoutProvider;
