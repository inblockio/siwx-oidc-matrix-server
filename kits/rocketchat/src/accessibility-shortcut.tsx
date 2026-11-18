// Bundler swap of Rocket.Chat's `AccessibilityShortcut` (patch reason class "D41 wire", M12 Z1): the "Skip to main content" link
// keeps Rocket.Chat's markup, label and show-on-focus styling; its click no longer follows the href. In Rocket.Chat the href
// (`<route path>#main-content`) is a same-page anchor; in the kit the route path is virtual (D8), so the browser navigated the
// kit frame to a path the host server does not have and the kit showed a 404. The click is kept in the page and moves the focus
// to the main content (src/skip-link.ts).
import { css } from '@rocket.chat/css-in-js';
import { Button } from '@rocket.chat/fuselage';
import { useRouter } from '@rocket.chat/ui-contexts';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MAIN_CONTENT_ID, focusMainContent } from './skip-link.ts';

const AccessibilityShortcut = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const currentRoutePath = router.getLocationPathname();

	const customButtonClass = css`
		position: absolute;
		top: 2px;
		left: 2px;
		z-index: 99;
		&:not(:focus) {
			width: 1px;
			height: 1px;
			padding: 0;
			overflow: hidden;
			clip: rect(1px, 1px, 1px, 1px);
			border: 0;
		}
	`;

	const skip = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		focusMainContent(event.currentTarget.ownerDocument);
	};

	return (
		<Button className={customButtonClass} is='a' href={`${currentRoutePath}#${MAIN_CONTENT_ID}`} onClick={skip} primary>
			{t('Skip_to_main_content')}
		</Button>
	);
};

export default AccessibilityShortcut;
