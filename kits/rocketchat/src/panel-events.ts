// M9: the kit's wiring of panel-events-core (entry.ts); a missing bridge is the kit's own startup report, not this module's.
import { getSource } from './adapter/bridge.ts';
import { setMessageJumpQueryStringParameter } from './jump-param.ts';
import { watchPanelEvents, type PanelEventDeps } from './panel-events-core.ts';
import { openRoom } from './room-opener.ts';

export const startPanelEvents = (router: PanelEventDeps['router']): (() => void) => {
	try {
		return watchPanelEvents({ source: getSource(), router, jump: setMessageJumpQueryStringParameter, openRoom });
	} catch {
		return () => undefined;
	}
};
