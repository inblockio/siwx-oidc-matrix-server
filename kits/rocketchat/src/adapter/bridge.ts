// Finds the host's bridge: on the kit's own window (set by the host before load), else on the parent (a reload
// inside the frame gives the kit a fresh window without it). Standalone (no host page) the fixture bridge stands in.
import type { ClientViewBridge } from '../bridge-types.ts';
import { BRIDGE_GLOBAL } from '../bridge-types.ts';
import { fixtureBridge } from './fixture-bridge.ts';
import { BridgeSource } from './source.ts';

type BridgeWindow = Window & { [BRIDGE_GLOBAL]?: ClientViewBridge };

export const findBridge = (win: Window = window): ClientViewBridge | undefined => {
	const own = (win as BridgeWindow)[BRIDGE_GLOBAL];
	if (own) return own;
	if (win.parent === win) return undefined;
	try {
		return (win.parent as BridgeWindow)[BRIDGE_GLOBAL];
	} catch {
		return undefined; // cross-origin parent: no bridge
	}
};

/** The bridge versions the kit works with: 1 reads only, 2 acts, 3 adds the M9 panels, 4 the M10 directory, 5 the M11 settings tabs, 6 the M12 media reveal, 7 the M13 `quickReact`, 8 the M14 `openUserInfo` and `copyMarkdown` (each addition is feature-checked). */
export const supportedBridgeVersion = (version: unknown): boolean => version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8;

let source: BridgeSource | undefined;

/** The adapter's source. Inside a host page without a bridge the kit stops here (the host's watchdog takes over). */
export const getSource = (): BridgeSource => {
	if (source) return source;
	const bridge = findBridge() ?? (window.parent === window ? fixtureBridge() : undefined);
	if (!bridge) throw new Error(`client view: no bridge (window.${BRIDGE_GLOBAL})`);
	// A version 1 host (no actions) still works: the kit reads, and every action it cannot send is rejected.
	if (!supportedBridgeVersion(bridge.version)) throw new Error(`client view: bridge version ${String(bridge.version)} is not supported`);
	source = new BridgeSource(bridge);
	return source;
};
