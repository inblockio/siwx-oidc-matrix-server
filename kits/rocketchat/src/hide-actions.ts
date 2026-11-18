/** The action ids removed by Rocket.Chat's `overrideUi` `hideActions`, by toolbox. */
export const HIDE_ACTIONS = {
	roomToolbox: ['mentions', 'starred-messages', 'discussions'],
	// D39 keeps the first three. D41, ids RC's `MessageToolbarActionMenu` and `MessageToolbarItem` filter by.
	messageToolbox: [
		'star-message',
		'unstar-message',
		'start-discussion',
		'mark-message-as-unread',
		'follow-message',
		'unfollow-message',
		'translate',
		'view-original',
		'reaction-list',
		'webdav-upload',
		'jump-to-message',
		'jump-to-pin-message',
		'jump-to-star-message',
	],
	// D39 keeps create-discussion. D41, ids RC's `MessageBoxActionsToolbar` filters by (`:75`, `:76`, `:77`). D45
	// (G1 = b): `share-location` is hidden too; location sharing stays in Element's own view.
	composerToolbox: ['create-discussion', 'timestamp', 'webdav-add', 'share-location'],
};

// D41, RC's own setting, drops the KaTeX formatter button (`messageBoxFormatting.ts:123`), and
// Element renders maths only behind the labs flag `feature_latex_maths`.
export const HIDE_SETTINGS = { Katex_Enabled: false } as const;
