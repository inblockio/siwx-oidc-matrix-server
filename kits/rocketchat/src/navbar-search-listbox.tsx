// Bundler swap of Rocket.Chat's NavBarSearchListbox (patch reason class "D41 wire", M10 W5): a copy of the original with one
// group "Search the server" after the local rows (also with 20 local hits and with "No results") for every non-empty term. Its two
// options hand the term to Element's own Spotlight through the bridge (public rooms, people); the room it joins or the person
// it opens opens here. The sidebar's own `/v1/spotlight` lookup is answered empty by adapter/sdk.ts: no search of ours.
import type { OverlayTriggerAria } from '@react-aria/overlays';
import type { OverlayTriggerState } from '@react-stately/overlays';
import { Box, SidebarItemIcon, Tile } from '@rocket.chat/fuselage';
import { useStableCallback, useOutsideClick } from '@rocket.chat/fuselage-hooks';
import { CustomScrollbars } from '@rocket.chat/ui-client';
import { useRef } from 'react';
import { useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import NavBarSearchItem from 'rc/client/navbar/NavBarSearch/NavBarSearchItem';
import NavBarSearchItemSkeleton from 'rc/client/navbar/NavBarSearch/NavBarSearchItemSkeleton';
import NavBarSearchNoResults from 'rc/client/navbar/NavBarSearch/NavBarSearchNoResults';
import NavBarSearchRow from 'rc/client/navbar/NavBarSearch/NavBarSearchRow';
import { useSearchItems } from 'rc/client/navbar/NavBarSearch/hooks/useSearchItems';
import { useListboxNavigation } from 'rc/client/navbar/NavBarSearch/hooks/useSearchNavigation';
import ResultsLiveRegion from 'rc/client/components/ResultsLiveRegion';

import { getSource } from './adapter/bridge.ts';
import { useOpenDirectory } from './directory-button.tsx';
import { activatesOption, searchHandOff, serverSearchAttributes, serverSearchOptions, type ServerSearchOption } from './server-search.ts';

export type NavBarSearchListBoxProps = {
	state: OverlayTriggerState;
	overlayProps: OverlayTriggerAria['overlayProps'];
};

const NavBarSearchListBox = ({ state, overlayProps }: NavBarSearchListBoxProps) => {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLElement>(null);

	const handleKeyDown = useListboxNavigation(state);
	useOutsideClick([containerRef], state.close);

	const { resetField, watch } = useFormContext();
	const { filterText } = watch();

	const handleSelect = useStableCallback(() => {
		state.close();
		resetField('filterText');
	});

	const openDirectory = useOpenDirectory();
	const serverOptions = serverSearchOptions(filterText, getSource().canOpenDirectory());
	// The search is cleared first (the listbox unmounts); the hand-off runs on, its toasts and room opening do not need it.
	const handleServerSearch = useStableCallback((option: ServerSearchOption) => {
		handleSelect();
		void openDirectory(searchHandOff(option));
	});

	const { items, isLoading } = useSearchItems(filterText);

	return (
		<Tile
			ref={containerRef}
			position='absolute'
			zIndex={99}
			padding={0}
			paddingBlock={16}
			marginBlockStart={4}
			minHeight='x52'
			maxHeight='50vh'
			display='flex'
			width='100%'
			flexDirection='column'
		>
			<ResultsLiveRegion shouldAnnounce={!isLoading} itemCount={items.length} isLoading={isLoading} />
			<CustomScrollbars>
				<div {...overlayProps} role='listbox' aria-label={t('Channels')} aria-busy={isLoading} tabIndex={-1} onKeyDown={handleKeyDown}>
					{items.length === 0 && !isLoading && <NavBarSearchNoResults />}
					{items.length > 0 && (
						<Box
							color='titles-labels'
							fontScale='c1'
							fontWeight='bold'
							paddingInline={12}
							marginBlockEnd={4}
							role='presentation'
							aria-hidden
						>
							{filterText ? t('Results') : t('Recent')}
						</Box>
					)}
					{items.map((item) => (
						<NavBarSearchRow key={item._id} room={item} onClick={handleSelect} />
					))}
					{serverOptions.length > 0 && (
						<Box color='titles-labels' fontScale='c1' fontWeight='bold' paddingInline={12} marginBlock={4} role='presentation' aria-hidden>
							Search the server
						</Box>
					)}
					{serverOptions.map((option) => (
						<NavBarSearchItem
							{...serverSearchAttributes(option)}
							key={option.filter}
							title={option.label}
							avatar={null}
							icon={<SidebarItemIcon icon={option.filter === 'rooms' ? 'hashtag' : 'user'} />}
							onClick={() => handleServerSearch(option)}
							onKeyDown={(e) => {
								if (activatesOption(e.key)) {
									e.preventDefault();
									handleServerSearch(option);
								}
							}}
						/>
					))}
					{isLoading && Array.from({ length: 4 }, (_, index) => <NavBarSearchItemSkeleton key={`skeleton-${index}`} />)}
				</div>
			</CustomScrollbars>
		</Tile>
	);
};

export default NavBarSearchListBox;
