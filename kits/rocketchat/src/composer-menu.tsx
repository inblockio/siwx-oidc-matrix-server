// Bundler swap of the `@rocket.chat/ui-client` import of Rocket.Chat's composer toolbar only (webpack.config.js, patch reason
// class "D41 hide", M12 X4, ruling FN5): the composer's "+" (More actions) is not drawn while its menu lists no item. With
// Create discussion, Timestamp, WebDAV and Share location hidden (D41, D45) the menu is empty at a composer width of 480 px
// or more, and Rocket.Chat would still draw a "+" that opens two bare section titles. Below 480 px the menu lists Video
// message, so the "+" stays. Everything else is Rocket.Chat's own `GenericMenu`; no other importer of ui-client is swapped.
import { GenericMenu as OriginalGenericMenu } from '@rocket.chat/ui-client';
import type { ComponentProps } from 'react';

import { isMenuWithoutItem } from './menu-empty.ts';

export const GenericMenu = (props: ComponentProps<typeof OriginalGenericMenu>) => (isMenuWithoutItem(props) ? null : <OriginalGenericMenu {...props} />);
