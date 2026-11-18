// Bundler swap of Rocket.Chat's RoomMessageContent that WRAPS it (0 source patches; patch reason class "E2EE signal",
// REQ-0007 D1): Rocket.Chat marks a message only e2e 'pending' | 'done' and has no place for the reason a message could
// not be decrypted or for an unverified-sender / unverified-device warning. The original renders unchanged; when the
// message carries `e2eWarning` (adapter/map.ts e2eFields), one note line follows it. No warning, no line.
import { Box } from '@rocket.chat/fuselage';
import type { IMessage } from '@rocket.chat/core-typings';
import { memo, type ComponentProps } from 'react';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import RoomMessageContent from 'rc/client/components/message/variants/room/RoomMessageContent.tsx?kit-original';

type Props = ComponentProps<typeof RoomMessageContent>;

const WithE2eeSignal = (props: Props) => {
	const warning = (props.message as IMessage & { e2eWarning?: string }).e2eWarning;
	return (
		<>
			<RoomMessageContent {...props} />
			{warning && (
				<Box role='note' data-kit-e2ee-warning='' color='danger' fontScale='p2'>
					{warning}
				</Box>
			)}
		</>
	);
};

export default memo(WithE2eeSignal);
