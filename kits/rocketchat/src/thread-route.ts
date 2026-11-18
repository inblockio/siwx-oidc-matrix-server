// M8 T1: Element's thread panel closes when Rocket.Chat's router leaves the panel's room (room change, Home, directory).
// Not `markRead`: a room already read is opened without a read call, and Mark as read of another room does not navigate.
import { getSource } from './adapter/bridge.ts';

export type RouteWatch = {
	subscribeToRouteChange(onRouteChange: () => void): () => void;
	getRouteParameters(): Record<string, string | undefined>;
};

export const watchThreadRoute = (router: RouteWatch, source: () => { routeChanged(p: { rid?: string; name?: string }): void } = getSource): (() => void) =>
	router.subscribeToRouteChange(() => {
		const { rid, name } = router.getRouteParameters();
		try {
			source().routeChanged({ rid, name });
		} catch {
			// no bridge yet: the kit's own startup reports it
		}
	});
