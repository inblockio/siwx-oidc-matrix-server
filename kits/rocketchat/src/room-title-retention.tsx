// Bundler swap of Rocket.Chat's room header title that WRAPS it (0 source patches; patch reason class "retention
// indicator", owner's ruling 2026-11-24): a room whose messages are deleted automatically shows a clock and the host's
// text ("Messages here are deleted after 2 weeks") right after the title, visible without hovering, in the header's
// secondary text colour. A long title truncates first; the line keeps its full width up to half of the header row and
// truncates only beyond that. The original title renders unchanged; a room without the indicator
// (src/retention-indicator.ts) gets exactly the original header.
import { Box, Icon } from '@rocket.chat/fuselage';
import type { ComponentProps } from 'react';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
// eslint-disable-next-line import/no-unresolved
import RoomTitle from 'rc/client/views/room/Header/RoomTitle.tsx?kit-original';

import { retentionIndicatorOf } from './retention-indicator.ts';

const RoomTitleWithRetention = (props: ComponentProps<typeof RoomTitle>) => {
	const text = retentionIndicatorOf(props.room)?.headerText;
	return (
		<>
			<RoomTitle {...props} />
			{text && (
				<Box
					is='span'
					data-kit-retention-text=''
					display='flex'
					alignItems='center'
					flexShrink={0}
					maxWidth='50%'
					color='hint'
					fontScale='p2'
					mie={8}
				>
					<Icon name='clock' size='x16' aria-hidden mie={4} />
					<Box is='span' withTruncatedText>
						{text}
					</Box>
				</Box>
			)}
		</>
	);
};

export default RoomTitleWithRetention;
