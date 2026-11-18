// Bundler swap of Rocket.Chat's navbar user menu hook (0 source patches): the original sections plus a "Switch view"
// section listing the host's other views from bridge.views(), so the user leaves Rocket.Chat from its own menu (H6).
// D41 hide: useStatusItems returns nothing, so the "Status" section is empty; it is dropped before the logic below (the
// Switch view section and the logout section, which is sliced off the end, stay as they are). M10 W4: the "Profile" item
// opens Element's settings dialog (bridge.openUserSettings) instead of Rocket.Chat's account page; M11 Y2: so do Preferences,
// Accessibility and Feature preview, each on its own tab (Feature preview inserted by the kit where Element lists a Labs tab).
import type { IUser } from '@rocket.chat/core-typings';
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';
import { useToastMessageDispatch, useTranslation } from '@rocket.chat/ui-contexts';
import { useUserMenu as useRocketChatUserMenu } // The query keeps this import out of the swap (its regex is anchored at `.tsx`), so it is the original module.
// eslint-disable-next-line import/no-unresolved
from 'rc/client/navbar/NavBarSettingsToolbar/UserMenu/hooks/useUserMenu.tsx?original';

import { getSource } from './adapter/bridge.ts';
import { withProfileHandler } from './profile-item.ts';
import { withoutEmptyStatusSection } from './x2-filters.ts';

export const KIT_ID = 'rocketchat';

export const switchViewItems = (source = getSource()): GenericMenuItemProps[] =>
	source
		.views()
		.filter((view) => view.id !== KIT_ID)
		.map((view) => ({ id: `switch-view-${view.id}`, content: `Switch to ${view.name}`, onClick: () => source.switchTo(view.id) }));

// A9: the "Log out" item asks the host for Element's sign-out (patch reason class "D17 single confirmation": Element's
// LogoutDialog is the one confirmation). Rocket.Chat's own item calls `Meteor.logout` (the stub does the same) and shows
// no error; a refusal here is Rocket.Chat's error toast. A dismissed dialog is no error.
export const useUserMenu = (user: IUser) => {
	const dispatchToastMessage = useToastMessageDispatch();
	const t = useTranslation();
	// M10 W4 (patch reason class "D41 wire"): "Profile" opens Element's settings dialog on its Account tab, the one place the name and avatar change.
	// M11 Y2 (D43): Preferences, Accessibility and Feature preview open it on their own tab (bridge version 5; Feature preview is inserted by the kit, with
	// Rocket.Chat's own label, only where Element lists a Labs tab; below version 5 those three are hidden).
	const sections = withProfileHandler(
		withoutEmptyStatusSection(useRocketChatUserMenu(user)),
		(tab) => void getSource().openUserSettings({ tab }).catch((error) => dispatchToastMessage({ type: 'error', message: error })),
		getSource().settingsTabs(),
		t('Feature_preview'),
	);
	const items = switchViewItems();
	const logoutSection = sections.slice(-1).map((section) => ({
		...section,
		items: section.items.map((item) =>
			item.id === 'logout' ? { ...item, onClick: () => void getSource().logout().catch((error) => dispatchToastMessage({ type: 'error', message: error })) } : item,
		),
	}));
	if (!items.length) return [...sections.slice(0, -1), ...logoutSection];
	// Above the logout section, which stays last.
	return [...sections.slice(0, -1), { title: 'Switch view', items }, ...logoutSection];
};
