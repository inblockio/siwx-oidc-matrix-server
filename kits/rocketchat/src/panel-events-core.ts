// M9: what Element's card panels ask of the kit. A jump (a pinned message, a search hit, a file's "jump to message") scrolls the
// kit to that message through Rocket.Chat's own jump parameter (jump-param.ts); a room the panel opens (a member's DM, a room
// link) is opened in the kit's router once the bridge shows it. The panel itself is closed by the host in both cases.
export type PanelEventSource = {
	onJump(cb: (j: { roomId: string; id: string }) => void): () => void;
	onRoomOpen(cb: (j: { roomId: string; id?: string }) => void): () => void;
	roomShown(rid: string): Promise<boolean>;
	room(rid: string): { name?: string } | undefined;
};

export type PanelEventDeps = {
	source: PanelEventSource;
	router: { getRouteParameters(): Record<string, string | undefined> };
	jump(id: string): unknown;
	openRoom(rid: string): void;
};

/** Subscribes the kit to the host's jump and room-open requests; returns the unsubscribe. */
export const watchPanelEvents = ({ source, router, jump, openRoom: open }: PanelEventDeps): (() => void) => {
	const routeShows = (rid: string): boolean => {
		const { rid: routeRid, name } = router.getRouteParameters();
		if (routeRid === rid) return true;
		const roomName = source.room(rid)?.name;
		return Boolean(roomName && name === roomName);
	};
	const offJump = source.onJump(({ roomId, id }) => {
		if (!routeShows(roomId)) open(roomId);
		void jump(id);
	});
	const offRoom = source.onRoomOpen(({ roomId, id }) => {
		void source.roomShown(roomId).then((shown) => {
			if (!shown) return;
			open(roomId);
			// A2: a search hit of another room opens it at the hit, the same jump path as onJump (page-back per decision 3).
			if (id) void jump(id);
		});
	});
	return () => {
		offJump();
		offRoom();
	};
};
