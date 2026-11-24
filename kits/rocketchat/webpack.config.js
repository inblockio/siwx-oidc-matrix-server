// Rocket.Chat 8.9.0 client bundled outside Meteor as an Element client view, modelled on apps/meteor/.storybook/main.ts.
// Swaps (bundler only, 0 Rocket.Chat source patches; AudioEncoder -> audio-encoder bundles the MP3 worker (reason class "recorder asset"), AudioRecorder + videoRecorder + VideoMessageRecorder -> audio-recorder / video-recorder / video-message-recorder (reason class "recorder fix")): meteor/* -> meteor-stub, SDKClient -> adapter/sdk, ddpSdk ->
// adapter/ddp-sdk, AvatarUrlProvider -> avatar-url-provider, useUserMenu -> user-menu
// (adds "Switch view"), setMessageJumpQueryStringParameter -> jump-param (virtual path, F4), RoomMessageContent ->
// e2e-warning (wraps it, the E2EE signal note, REQ-0007), MessageListProvider + ReactionMessageAction -> wrappers whose
// "Add reaction" opens Element's picker (reason class "D17 Element picker"), ForwardMessageAction -> forward-message-action (Forward opens Element's forward dialog, reason class "D31 dialog"), useReadReceiptsDetailsAction -> view-source-action (its More-menu slot carries "View source", Element's dialog, reason class "D31 dialog"), useWebDAVMessageAction -> copy-markdown-action (its More-menu slot carries "Copy Markdown", Element's eventToMarkdown through the bridge, reason class "D29 shared util"), useEditMessageAction -> edit-message-action (wraps it:
// Edit only where Element's edit rule allows, reason class "N/A hook"), usePin/UnpinMessageAction -> pin-/unpin-message-action (wrap them: Pin only where Element offers it, reason class "N/A hook"), useReportMessageAction -> report-message-action (wraps it: Report opens Element's report dialog, reason class "D17 Element dialog"), usePermalinkAction -> permalink-action (wraps it: Copy link copies
// Element's permalink of the event, reason class "D17 Element permalink"), "Create new" Channel / Direct message + the room menu's Leave + the composer's Upload file -> wrappers that open Element's dialogs and flows (reason class "D17 single confirmation"), `useCategoryModals` -> category-modals.ts (the "New category" modal is Element's create-section dialog) and `useIsEnterprise` at the category sites only -> ungate-category.ts (reason class "ungate category"), free `location`/`history` -> reload.ts (virtual, D8), `AccessibilityShortcut` -> accessibility-shortcut.tsx (the "Skip to main content" link focuses the main content instead of following its href, reason class "D41 wire"), `localforage` -> localforage-memory.ts (reason class "privacy: no persistence": the view's cache never reaches IndexedDB).
const path = require('path');

const RC = process.env.RC_ROOT || path.join(process.env.HOME, '.cache/element-views-track/rocket.chat');
const METEOR_APP = path.join(RC, 'apps/meteor');
const { excludedPackages: _excluded, plugins: postcssRc } = JSON.parse(require('fs').readFileSync(path.join(METEOR_APP, '.postcssrc'), 'utf8'));
// postcss-easy-import is left out: css-loader resolves @import itself (keeps each file's relative font URLs).
const postcssPlugins = Object.entries(postcssRc).filter(([name]) => name !== 'postcss-easy-import').map(([name, opts]) => [require.resolve(name, { paths: [METEOR_APP, RC] }), opts]);
const rcRequire = (m) => require(require.resolve(m, { paths: [METEOR_APP, RC] }));
const webpack = rcRequire('webpack');
const HtmlWebpackPlugin = rcRequire('html-webpack-plugin');
const src = (f) => path.join(__dirname, 'src', f);
const swiperRoot = path.dirname(require.resolve('swiper/package.json', { paths: [METEOR_APP] }));
const swcLoader = path.join(RC, 'node_modules/@storybook/addon-webpack5-compiler-swc/node_modules/swc-loader');

// Replacement by resolved file (afterResolve) so every relative import of the module is caught. The swapped module
// gets its own directory as context, so its relative imports resolve inside the kit, not next to the original.
const replaceFile = (re, file) =>
	new webpack.NormalModuleReplacementPlugin(re, (data) => {
		if (!data.createData) return;
		data.createData.resource = file;
		data.createData.context = path.dirname(file);
	});

// M6 B1, patch class "ungate category": the premium gate (`useIsEnterprise`) is opened at the sites of custom categories
// only: the room menu (Move to), the room header's grouping menu, the category items of both, the sidebar's category list and
// the user's categories. M10 W23 adds the group header (`sidebar/RoomList/RoomListCollapser.tsx`): its menu (rename, delete,
// move up / down, "Create new") renders now; its inline Unreads section (no Element counterpart, D41) is removed by the swap
// of `CategoryMenu` below (`src/category-menu.tsx`), guarded in `test/x2-hidden.test.ts`. The room list's empty-group rule
// (`useRoomList.ts`) keeps the original. `/v1/licenses.info` is never answered.
const UNGATED_SITES = /\/client\/(sidebar\/RoomMenu\.tsx|sidebar\/RoomList\/RoomListCollapser\.tsx|views\/room\/Header\/icons\/RoomGroupingMenu\.tsx|sidebar\/hooks\/useCategoryList\.ts|sidebar\/categories\/hooks\/(useRoomCategoryItems|useUserSidebarCategories)\.tsx?)$/;
const ungateCategory = new webpack.NormalModuleReplacementPlugin(/\/client\/hooks\/useIsEnterprise\.ts$/, (data) => {
	if (!data.createData || !UNGATED_SITES.test(data.contextInfo?.issuer ?? '')) return;
	// A module's identity is its request, not its resource: the request changes too, or webpack takes the original module
	// the other importers made for the same file (the swap would be dropped).
	const file = src('ungate-category.ts');
	for (const key of ['request', 'userRequest', 'rawRequest']) {
		if (typeof data.createData[key] === 'string') data.createData[key] = data.createData[key].replace(data.createData.resource, file);
	}
	data.createData.resource = file;
	data.createData.context = path.dirname(file);
});

// M12 X4, patch class "D41 hide" (FN5): the composer's "+" (More actions) is not drawn while its menu lists no item. Only the
// `@rocket.chat/ui-client` import of the composer toolbar is swapped (by issuer, in beforeResolve, where the request is still
// the package name); `src/composer-menu.tsx` wraps Rocket.Chat's `GenericMenu` and imports the package itself, unswapped.
const hideEmptyComposerMenu = new webpack.NormalModuleReplacementPlugin(/^@rocket\.chat\/ui-client$/, (data) => {
	// beforeResolve gets `createData` as an empty object already (it is filled in afterResolve), so it is no guard here.
	if (!/\/MessageBoxActionsToolbar\.tsx$/.test(data.contextInfo?.issuer ?? '')) return;
	data.request = src('composer-menu.tsx');
});

module.exports = {
	mode: 'development',
	devtool: false,
	context: __dirname,
	entry: src('entry.ts'),
	output: { path: process.env.KIT_OUT || path.join(__dirname, 'dist'), filename: 'kit.[name].js', publicPath: process.env.KIT_PUBLIC_PATH || '/kits/rocketchat/', clean: true },
	resolve: {
		extensions: ['.tsx', '.ts', '.mjs', '.js', '.json'],
		modules: [path.join(METEOR_APP, 'node_modules'), path.join(RC, 'node_modules'), 'node_modules'],
		alias: {
			'rc': METEOR_APP,
			// The audio recorder's MP3 encoder worker source (B6, src/mp3-encoder-worker.ts).
			'rc-mp3-encoder$': path.join(RC, 'packages/mp3-encoder/src/index.ts'),
			// No persistence of the view's cached rooms and subscriptions (A9: they outlived the sign-out).
			'localforage$': src('localforage-memory.ts'),
			'react$': path.join(RC, 'node_modules/react'),
			'@tanstack/react-query': path.join(RC, 'node_modules/@tanstack/react-query'),
			'@rocket.chat/fuselage$': path.join(RC, 'node_modules/@rocket.chat/fuselage'),
			'@rocket.chat/license': src('ee-stub.ts'),
			'@rocket.chat/abac': src('ee-stub.ts'),
			'swiper/swiper-react.mjs$': path.join(swiperRoot, 'swiper-react.mjs'),
			'swiper/modules/index.mjs$': path.join(swiperRoot, 'modules/index.mjs'),
			'swiper/swiper.css$': path.join(swiperRoot, 'swiper.css'),
			'swiper/modules/zoom.css$': path.join(swiperRoot, 'modules/zoom.css'),
		},
		roots: [path.join(METEOR_APP, 'public')],
		fallback: { crypto: false, fs: false, path: false, os: false, stream: false, buffer: false, util: false },
	},
	module: {
		rules: [
			{
				test: /\.(m?[jt]sx?)$/,
				exclude: /node_modules/,
				type: 'javascript/auto',
				use: {
					loader: swcLoader,
					options: {
						jsc: {
							target: 'es2022',
							parser: { syntax: 'typescript', tsx: true, decorators: true },
							transform: { react: { runtime: 'automatic' }, legacyDecorator: true },
						},
					},
				},
			},
			{ test: /\.m?js$/, resolve: { fullySpecified: false } },
			// The capability table ships as text: the overlay parses the same file the spec walks.
			{ test: /CAPABILITIES\.md$/, type: 'asset/source' },
			// Rocket.Chat's own CSS goes through its PostCSS chain (apps/meteor/.postcssrc: nesting, custom properties).
			{
				test: /\.css$/,
				exclude: /node_modules/,
				use: ['style-loader', { loader: 'css-loader', options: { importLoaders: 1 } }, { loader: 'postcss-loader', options: { postcssOptions: { config: false, plugins: postcssPlugins.map(([p, o]) => require(p)(o)) } } }],
			},
			{ test: /\.css$/, include: /node_modules/, use: ['style-loader', 'css-loader'] },
			{ test: /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|mp3|ogg)$/, type: 'asset/resource' },
		],
	},
	resolveLoader: { modules: [path.join(RC, 'node_modules'), 'node_modules'] },
	plugins: [
		new webpack.NormalModuleReplacementPlugin(/^meteor\//, src('meteor-stub.ts')),
		new webpack.NormalModuleReplacementPlugin(/^(?!.*node_modules).*(app)\/*.*\/(server)\/*/, path.join(METEOR_APP, '.storybook/mocks/empty.ts')),
		new webpack.NormalModuleReplacementPlugin(/rocketchat\.info$/, path.join(METEOR_APP, '.storybook/mocks/rocketchat.info.ts')),
		new webpack.NormalModuleReplacementPlugin(/^mime-type\/with-db$/, path.join(METEOR_APP, '.storybook/mocks/mimeType.ts')),
		new webpack.NormalModuleReplacementPlugin(/\/ee\/lib\/misc\/Utilities$/, src('ee-stub.ts')),
		replaceFile(/client\/lib\/SDKClient\.ts$/, src('adapter/sdk.ts')),
		replaceFile(/client\/lib\/sdk\/ddpSdk\.ts$/, src('adapter/ddp-sdk.ts')),
		replaceFile(/client\/providers\/AvatarUrlProvider\.tsx$/, src('avatar-url-provider.tsx')),
		replaceFile(/client\/providers\/AttachmentProvider\.tsx$/, src('attachment-provider.tsx')),
		replaceFile(/attachments\/structure\/AttachmentDownloadBase\.tsx$/, src('attachment-download.tsx')),
		// M12 Z3, patch class "D41 wire": a hidden image shows Rocket.Chat's own Load box, whose click is Element's reveal (a copy of the original plus one marker prop).
		replaceFile(/attachments\/file\/ImageAttachment\.tsx$/, src('image-attachment.tsx')),
		replaceFile(/client\/navbar\/NavBarSettingsToolbar\/UserMenu\/hooks\/useUserMenu\.tsx$/, src('user-menu.tsx')),
		replaceFile(/client\/lib\/utils\/setMessageJumpQueryStringParameter\.ts$/, src('jump-param.ts')),
		replaceFile(/message\/variants\/room\/RoomMessageContent\.tsx$/, src('e2e-warning.tsx')),
		// M9 Q1, patch class "D40 quote": the whole quote is a jump to the quoted message (wraps the original).
		replaceFile(/attachments\/QuoteAttachment\.tsx$/, src('quote-attachment.tsx')),
		replaceFile(/views\/room\/MessageList\/providers\/MessageListProvider\.tsx$/, src('message-list-provider.tsx')),
		replaceFile(/message\/toolbar\/items\/actions\/ReactionMessageAction\.tsx$/, src('reaction-message-action.tsx')),
		replaceFile(/message\/toolbar\/items\/actions\/ForwardMessageAction\.tsx$/, src('forward-message-action.tsx')),
		replaceFile(/message\/toolbar\/items\/actions\/ReplyInThreadMessageAction\.tsx$/, src('reply-in-thread-action.tsx')),
		replaceFile(/views\/room\/hooks\/useGoToThread\.ts$/, src('go-to-thread.ts')),
		// M14 K4, patch class "D41 wire" (interim): a click on a sender opens Element's user info of that member in the host panel slot (bridge.openUserInfo), not Rocket.Chat's user card.
		replaceFile(/views\/room\/providers\/UserCardProvider\.tsx$/, src('user-card-provider.tsx')),
		// M12 Z1, patch class "D41 wire": the "Skip to main content" link keeps the page and moves the focus to the main content (its href is a virtual route path in the kit).
		replaceFile(/views\/root\/MainLayout\/AccessibilityShortcut\.tsx$/, src('accessibility-shortcut.tsx')),
		// M9 "D39 header" (interim): Element's own cards in the host panel slot (bridge.openPanel), one component for every tab.
		replaceFile(/views\/room\/contextualBar\/Info\/index\.ts$/, src('host-panel-tab.tsx')),
		replaceFile(/views\/room\/MemberListRouter\.tsx$/, src('host-panel-tab.tsx')),
		replaceFile(/views\/room\/contextualBar\/RoomFiles\/index\.ts$/, src('host-panel-tab.tsx')),
		replaceFile(/views\/room\/contextualBar\/PinnedMessagesTab\.tsx$/, src('host-panel-tab.tsx')),
		replaceFile(/views\/room\/contextualBar\/MessageSearchTab\/index\.ts$/, src('host-panel-tab.tsx')),
		replaceFile(/message\/toolbar\/useReadReceiptsDetailsAction\.tsx$/, src('view-source-action.tsx')),
		// M14 K6, patch class "D29 shared util": the dead WebDAV slot of the "More" menu carries "Copy Markdown" (Element's eventToMarkdown through the bridge's copyMarkdown).
		replaceFile(/message\/toolbar\/useWebDAVMessageAction\.tsx$/, src('copy-markdown-action.tsx')),
		// E0, patch class "D17 Element picker": wraps the provider; a reaction made through Element's picker or a chip is remembered as a quick reaction.
		replaceFile(/client\/providers\/EmojiPickerProvider\/EmojiPickerProvider\.tsx$/, src('emoji-picker-provider.tsx')),
		replaceFile(/navbar\/NavBarPagesGroup\/hooks\/useCreateNewItems\.ts$/, src('create-new-items.ts')),
		// M10 W1, patch class "D41 wire": the Directory button and the small-screen Pages menu open Element's Directory over the view (bridge.openDirectory).
		replaceFile(/navbar\/NavBarPagesGroup\/NavBarItemDirectoryPage\.tsx$/, src('directory-button.tsx')),
		replaceFile(/navbar\/NavBarPagesGroup\/NavBarPagesStackMenu\.tsx$/, src('pages-stack-menu.tsx')),
		// M10 W5, patch class "D41 wire": the sidebar search lists, for a typed term, two options that hand it to Element's own Spotlight (bridge.openDirectory, public rooms / people).
		replaceFile(/navbar\/NavBarSearch\/NavBarSearchListbox\.tsx$/, src('navbar-search-listbox.tsx')),
		replaceFile(/client\/providers\/LayoutProvider\.tsx$/, src('layout-provider.tsx')),
		// M10 X2, patch class "D41 hide": no Element equivalent. Display prefs, room Hide (sidebar and side panel), the thread follow bell, status items, Manage.
		replaceFile(/NavBarPagesGroup\/hooks\/useSortMenu\.ts$/, src('sort-menu.ts')),
		// M10 W6, patch class "D41 wire": Rocket.Chat never re-sorts the sidebar; the bridged order is Element's (see the file).
		replaceFile(/client\/hooks\/useSortQueryOptions\.ts$/, src('sort-query-options.ts')),
		replaceFile(/client\/hooks\/useRoomMenuActions\.ts$/, src('room-menu-actions.ts')),
		replaceFile(/sidepanel\/hooks\/useRoomMenuActions\.ts$/, src('sidepanel-room-menu-actions.ts')),
		replaceFile(/message\/content\/ThreadMetricsFollow\.tsx$/, src('thread-follow.ts')),
		replaceFile(/UserMenu\/hooks\/useStatusItems\.tsx$/, src('status-items.ts')),
		replaceFile(/NavBarSettingsToolbar\/NavBarItemAdministrationMenu\.tsx$/, src('admin-menu.ts')),
		replaceFile(/hooks\/menuActions\/useLeaveRoom\.tsx$/, src('leave-room-action.tsx')),
		replaceFile(/VideoConference\/hooks\/useVideoConfOpenCall\.tsx$/, src('call-window.tsx')),
		replaceFile(/messageBox\/MessageBoxActionsToolbar\/hooks\/useFileUploadAction\.ts$/, src('file-upload-action.ts')),
		replaceFile(/message\/toolbar\/useEditMessageAction\.ts$/, src('edit-message-action.ts')),
		replaceFile(/message\/toolbar\/usePinMessageAction\.tsx$/, src('pin-message-action.tsx')),
		replaceFile(/message\/toolbar\/useUnpinMessageAction\.ts$/, src('unpin-message-action.ts')),
		replaceFile(/message\/toolbar\/useReportMessageAction\.tsx$/, src('report-message-action.tsx')),
		// M11 Y4, patch class "D41 wire": "Reply in direct message" opens, or starts, Element's direct chat with the sender (bridge.startDm)
		// instead of Rocket.Chat's /direct route with `reply=`; it wraps the original (the kit hides the item for your own message).
		replaceFile(/message\/toolbar\/useReplyInDMAction\.ts$/, src('reply-directly-action.ts')),
		replaceFile(/sidebar\/categories\/hooks\/useCategoryModals\.tsx$/, src('category-modals.ts')),
		replaceFile(/sidebar\/categories\/CategoryMenu\.tsx$/, src('category-menu.tsx')),
		ungateCategory,
		hideEmptyComposerMenu,
		replaceFile(/message\/toolbar\/usePermalinkAction\.ts$/, src('permalink-action.ts')),
		replaceFile(/client\/lib\/chats\/flows\/uploadFiles\.ts$/, src('upload-files-flow.ts')),
		replaceFile(/client\/lib\/AudioEncoder\.ts$/, src('audio-encoder.ts')),
		replaceFile(/client\/lib\/AudioRecorder\.ts$/, src('audio-recorder.ts')),
		replaceFile(/client\/lib\/videoRecorder\.ts$/, src('video-recorder.ts')),
		replaceFile(/composer\/VideoMessageRecorder\/VideoMessageRecorder\.tsx$/, src('video-message-recorder.tsx')),
		// M12 X4, reason class "D41 hide": Element's connection bar has no retry; the client reconnects itself.
		replaceFile(/components\/connectionStatus\/ConnectionStatusBar\.tsx$/, src('connection-status-bar.tsx')),
		// Room retention indicator (owner's ruling 2026-11-24), reason class "retention indicator": the sidebar row and the
		// header title wrap the originals and add the host's clock and text for a room whose messages are deleted automatically.
		replaceFile(/client\/sidebar\/RoomList\/SidebarItemTemplateWithData\.tsx$/, src('sidebar-item-retention.tsx')),
		replaceFile(/client\/views\/room\/Header\/RoomTitle\.tsx$/, src('room-title-retention.tsx')),
		new webpack.DefinePlugin({
			'process.env.NODE_ENV': JSON.stringify('development'),
			'process.env.TEST_MODE': JSON.stringify(''),
			'Meteor.isClient': 'true',
		}),
		new webpack.ProvidePlugin({
			process: path.join(RC, 'node_modules/process/browser.js'),
			location: [src('reload.ts'), 'location'],
			history: [src('reload.ts'), 'history'],
		}),
		new HtmlWebpackPlugin({ template: src('index.html') }),
	],
	performance: { hints: false },
	stats: { all: false, errors: true, warnings: true, assets: true, modules: true, nestedModules: true, chunkModules: true, modulesSpace: 100000 },
};
