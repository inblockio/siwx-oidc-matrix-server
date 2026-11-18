// Bundler swap of Rocket.Chat's `useCategoryModals` (patch reason class "ungate category"): the premium build opens the upsell
// here without a licence and its own create / manage / delete modals with one. "New category" opens Element's create-section
// dialog over the view instead (the host's `createSection`, D17: Element's dialog is the one confirmation; it names the
// section and offers the room picker, the room of a "Move to" preselected). M10 W23: Manage opens Element's own section dialog
// in edit mode (`editSection`, rename) and Delete Element's `RemoveSectionDialog` (`removeSection`), both feature-checked in the
// source (a bridge without them answers code `unsupported`, shown as an error toast); the category's tag is its `_id`. Neither
// ever calls `setCategory`: the host's dialog does the write and the sections arrive through the bridge.
import type { ISidebarCategory } from '@rocket.chat/core-typings';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getSource } from './adapter/bridge.ts';

type MovableRoom = { rid: string; name?: string; isFavorite?: boolean; categoryId?: string };

export const useCategoryModals = () => {
	const { t } = useTranslation();
	const dispatchToastMessage = useToastMessageDispatch();
	return useMemo(() => {
		const openCreate = async (room?: MovableRoom): Promise<void> => {
			try {
				const outcome = await getSource().createSection(room?.rid);
				if (outcome.status === 'done') dispatchToastMessage({ type: 'success', message: t('Category_created') });
			} catch (error) {
				dispatchToastMessage({ type: 'error', message: error });
			}
		};
		const run = (start: (tag: string) => Promise<unknown>) => async (category: ISidebarCategory): Promise<void> => {
			try {
				await start(category._id);
			} catch (error) {
				dispatchToastMessage({ type: 'error', message: error });
			}
		};
		const manage = run((tag) => getSource().editSection(tag));
		const remove = run((tag) => getSource().removeSection(tag));
		return {
			openCreate: (room?: MovableRoom) => void openCreate(room),
			openManage: (category: ISidebarCategory) => void manage(category),
			openDelete: (category: ISidebarCategory) => void remove(category),
		};
	}, [dispatchToastMessage, t]);
};
