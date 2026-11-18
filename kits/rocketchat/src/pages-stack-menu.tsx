// Bundler swap of Rocket.Chat's "Pages" stack menu (small screens; patch reason class "D41 wire"): a copy of the original with
// the Directory item opening Element's Directory (useOpenDirectory) instead of navigating to /directory. Only Home is a route here.
import { NavBarItem } from '@rocket.chat/fuselage';
import { useStableCallback } from '@rocket.chat/fuselage-hooks';
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';
import { GenericMenu } from '@rocket.chat/ui-client';
import { useCurrentRoutePath, useLayout, useRouter, useSetting } from '@rocket.chat/ui-contexts';
import type { HTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import { useOpenDirectory } from './directory-button.tsx';

export type NavBarPagesStackMenuProps = Omit<HTMLAttributes<HTMLElement>, 'is'>;

const NavBarPagesStackMenu = (props: NavBarPagesStackMenuProps) => {
	const { t } = useTranslation();

	const showHome = useSetting('Layout_Show_Home_Button');
	const { sidebar } = useLayout();
	const router = useRouter();
	const openDirectory = useOpenDirectory();

	const handleGoToHome = useStableCallback(() => {
		sidebar.toggle();
		router.navigate('/home');
	});

	const currentRoute = useCurrentRoutePath();
	const pressed = currentRoute?.includes('/home');

	const items = [
		showHome && {
			id: 'home',
			icon: 'home',
			content: t('Home'),
			onClick: handleGoToHome,
		},
		{
			id: 'directory',
			icon: 'notebook-hashtag',
			content: t('Directory'),
			onClick: () => void openDirectory(),
		},
	].filter(Boolean) as GenericMenuItemProps[];

	return (
		<GenericMenu items={items} title={t('Pages')} is={NavBarItem} placement='bottom-start' icon='stack' pressed={pressed} {...props} />
	);
};

export default NavBarPagesStackMenu;
