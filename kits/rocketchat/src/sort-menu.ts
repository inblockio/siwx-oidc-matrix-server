// Bundler swap of Rocket.Chat's Display menu (patch class "D41 hide"): view mode, avatars and grouping have no Element
// equivalent, so they are removed. Sort by stays (W6).
import type { useSortMenu as UseRocketChatSortMenu } from 'rc/client/navbar/NavBarPagesGroup/hooks/useSortMenu.ts?kit-original';
// The query keeps this import out of the swap (webpack.config.js replaces by file name, and a name with a query differs).
import { useSortMenu as useRocketChatSortMenu } from 'rc/client/navbar/NavBarPagesGroup/hooks/useSortMenu.ts?kit-original';

import { withoutDisplayPrefs } from './x2-filters.ts';

export const useSortMenu: typeof UseRocketChatSortMenu = () => withoutDisplayPrefs(useRocketChatSortMenu());
