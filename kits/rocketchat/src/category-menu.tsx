// Bundler swap of Rocket.Chat's `sidebar/categories/CategoryMenu` (patch reason class "D41 hide"): the group header's menu is
// rendered now (RoomListCollapser is un-gated, webpack.config.js `UNGATED_SITES`; W2 rename, W3 delete), and its inline
// "Unreads" section (Always display, Keep on top) has no Element equivalent (D41), so this copy drops it: `unreadItems`, the
// section, `useToggleUnreads` and the `sidebarShowUnread` preference are gone. The built-in groups (Favorites, Channels, Direct
// messages) get no menu at all (`hasCategoryMenu`): it would hold only the move items. Move up / Move down (row `category-manage`,
// `interim (D41)`, M11 Y3) are wired to the host: `getSource().moveSection` (`RoomListStoreV3.reorderSection`, Element's own drag),
// enabled by the position among the user's custom categories (`moveEdges` over `useUserSidebarCategories`, Element's order) and by a
// host that has the method; the original `canMoveUp` / `canMoveDown` / `onMoveUp` / `onMoveDown` props (RC counts the system groups, and
// its `setCategory` writes RC's own preference) are ignored, and RC's `useMoveCategoryPosition` is never called. Everything else is
// the original, line for line: the "Create new" submenu of a custom category (row `category-create-new`;
// it reuses the kit's `useCreateNewItems` swap and `useMoveRoomCategory`, which files the new room under the category), and
// Manage / Delete (rows `category-rename` and `category-delete`, `useCategoryModals`). The unread toggles are guarded by
// `test/x2-hidden.test.ts`; no CSS hides anything.
import type { ISidebarCategory } from '@rocket.chat/core-typings';
import { Menu, MenuItem, MenuItemContent, MenuItemIcon, MenuSection, MenuSubmenuTrigger } from '@rocket.chat/fuselage';
import { useToggle } from '@rocket.chat/fuselage-hooks';
import { GenericMenuItem, useHandleMenuAction } from '@rocket.chat/ui-client';
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useCategoryModals } from 'rc/client/sidebar/categories/hooks/useCategoryModals';
import { useMoveRoomCategory } from 'rc/client/sidebar/categories/hooks/useMoveRoomCategory';
import { useUserSidebarCategories } from 'rc/client/sidebar/categories/hooks/useUserSidebarCategories';
import { useCreateNewItems } from 'rc/client/navbar/NavBarPagesGroup/hooks/useCreateNewItems';

import { getSource } from './adapter/bridge.ts';
import { moveFailure } from './adapter/source.ts';
import { hasCategoryMenu, moveEdges } from './x2-filters.ts';

// RoomListCollapser still passes the unread flags (and the group key) and RC's move flags / handlers; the menu ignores them.
type CategoryMenuProps = {
	category?: ISidebarCategory;
	groupKey: string;
	showUnreads: boolean;
	keepUnreadsOnTop: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
};

const CategoryMenuItems = ({ category }: CategoryMenuProps) => {
	const { t } = useTranslation();
	const dispatchToastMessage = useToastMessageDispatch();
	const { customCategories } = useUserSidebarCategories();
	const { canMoveUp, canMoveDown } = moveEdges(
		customCategories.map((c) => c._id),
		category?._id ?? '',
		getSource().canMoveSection,
	);
	const move = (direction: 'up' | 'down') => {
		if (!category) {
			return;
		}

		getSource()
			.moveSection(category._id, direction)
			.catch((e: unknown) => dispatchToastMessage({ type: 'error', message: moveFailure(e) }));
	};
	const [isOpen, toggleOpen] = useToggle(false);
	const close = () => toggleOpen(false);

	const { openManage, openDelete } = useCategoryModals();
	const moveRoomCategory = useMoveRoomCategory();

	const onCreateSuccess = async (rid: string, name?: string) => {
		if (!category) {
			return;
		}

		await moveRoomCategory.mutateAsync({ room: { rid, name, isFavorite: false }, target: category._id, silent: true });
	};

	const rawCreateItems = useCreateNewItems({ onCreateSuccess });
	const createItems = category ? rawCreateItems : [];

	const orderItems: GenericMenuItemProps[] = [
		{
			id: 'move-up',
			icon: 'arrow-up',
			content: t('Move_up'),
			disabled: !canMoveUp,
			onClick: () => {
				close();
				move('up');
			},
		},
		{
			id: 'move-down',
			icon: 'arrow-down',
			content: t('Move_down'),
			disabled: !canMoveDown,
			onClick: () => {
				close();
				move('down');
			},
		},
	];

	const manageItems: GenericMenuItemProps[] = category
		? [
				{
					id: 'manage',
					icon: 'cog',
					content: t('Manage'),
					onClick: () => {
						close();
						openManage(category);
					},
				},
				{
					id: 'delete',
					icon: 'trash',
					content: t('Delete'),
					onClick: () => {
						close();
						openDelete(category);
					},
				},
			]
		: [];

	const allItems = [...orderItems, ...(category ? manageItems : []), ...createItems];
	const disabledKeys = allItems.filter(({ disabled }) => disabled).map(({ id }) => id);

	const handleAction = useHandleMenuAction(allItems);

	return (
		<Menu
			icon='kebab'
			title={t('Options')}
			mini
			selectionMode='multiple'
			isOpen={isOpen}
			onOpenChange={toggleOpen}
			{...(disabledKeys.length ? { disabledKeys } : {})}
			onAction={handleAction}
		>
			{[
				<MenuSection key='main' aria-label={t('Options')}>
					<>
						{orderItems.map((item) => (
							<MenuItem key={item.id}>
								<GenericMenuItem {...item} />
							</MenuItem>
						))}
						{category && createItems.length > 0 && (
							<MenuSubmenuTrigger key='create-new' textValue={t('Create_new')}>
								<MenuItem aria-label={t('Create_new')}>
									<MenuItemIcon name='plus' />
									<MenuItemContent>{t('Create_new')}</MenuItemContent>
								</MenuItem>
								<MenuSection items={createItems}>
									{(item) => (
										<MenuItem key={item.id}>
											<GenericMenuItem {...item} />
										</MenuItem>
									)}
								</MenuSection>
							</MenuSubmenuTrigger>
						)}
						{category &&
							manageItems.map((item) => (
								<MenuItem key={item.id}>
									<GenericMenuItem {...item} />
								</MenuItem>
							))}
					</>
				</MenuSection>,
			]}
		</Menu>
	);
};

// The built-in groups (Favorites, Channels, Direct messages) get no menu: it would hold only the N/A move items.
const CategoryMenu = (props: CategoryMenuProps) => (hasCategoryMenu(props.category) ? <CategoryMenuItems {...props} /> : null);

export default memo(CategoryMenu);
