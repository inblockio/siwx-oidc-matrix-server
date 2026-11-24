// Bundler swap of Rocket.Chat's SidebarItemTemplateWithData that WRAPS it (0 source patches; patch reason class "retention
// indicator", owner's ruling 2026-11-24): a room whose messages are deleted automatically shows a clock right before its
// name in the sidebar, with the host's text ("Messages are deleted after 2 weeks") as its accessible label and tooltip
// (Rocket.Chat's tooltip provider reads `title`). The row link's own aria-label hides its content, so the row names the
// clock as its description. The original renders unchanged; a room without the indicator (src/retention-indicator.ts)
// gets exactly the original row.
import { Box, Icon } from '@rocket.chat/fuselage';
import { createContext, useContext, useId, type ComponentProps, type ComponentType } from 'react';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
// eslint-disable-next-line import/no-unresolved
import SidebarItemTemplateWithData from 'rc/client/sidebar/RoomList/SidebarItemTemplateWithData.tsx?kit-original';

import { retentionIndicatorOf } from './retention-indicator.ts';

type Props = ComponentProps<typeof SidebarItemTemplateWithData>;
type Template = Props['SidebarItemTemplate'];
type TemplateProps = Template extends ComponentType<infer P> ? P : never;

/** The clock's label for the row being drawn; the original row renders its template, which reads it here. */
const RetentionLabel = createContext<string | undefined>(undefined);

export const RetentionClock = ({ id, label }: { id: string; label: string }) => (
	<Box
		is='span'
		id={id}
		role='img'
		aria-label={label}
		title={label}
		data-kit-retention-clock=''
		display='flex'
		alignItems='center'
		flexShrink={0}
		color='hint'
		mie={4}
	>
		<Icon name='clock' size='x16' aria-hidden />
	</Box>
);

// One wrapped template per Rocket.Chat template (extended, medium, condensed): a stable identity, so the original's memo
// comparison (`SidebarItemTemplate` among its keys) still holds.
const wrapped = new WeakMap<Template, Template>();

const withRetentionClock = (Template: Template): Template => {
	const known = wrapped.get(Template);
	if (known) return known;
	const WithClock = (props: TemplateProps) => {
		const label = useContext(RetentionLabel);
		const id = useId();
		if (!label) return <Template {...props} />;
		return (
			<Template
				{...props}
				aria-describedby={id}
				icon={
					<>
						{props.icon}
						<RetentionClock id={id} label={label} />
					</>
				}
			/>
		);
	};
	wrapped.set(Template, WithClock as Template);
	return WithClock as Template;
};

const SidebarItemWithRetention = (props: Props) => (
	<RetentionLabel.Provider value={retentionIndicatorOf(props.room)?.listLabel}>
		<SidebarItemTemplateWithData {...props} SidebarItemTemplate={withRetentionClock(props.SidebarItemTemplate)} />
	</RetentionLabel.Provider>
);

export default SidebarItemWithRetention;
