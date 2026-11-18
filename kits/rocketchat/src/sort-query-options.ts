// Bundler swap of Rocket.Chat's `useSortQueryOptions` (patch class "D41 wire", M10 W6). Rocket.Chat sorts its sidebar itself by the
// `sidebarSortby` preference: `activity` by last-message time, anything else (the `alphabetical` radio, but also `unread-first` and an
// unset one) by name. The kit's sidebar stays in the bridged order, which is the order of Element's room list under the sort Element
// holds (Activity, A-Z, or unread first), carried as descending `lm` times. So the sort is always `lm`, whatever the preference says.
import type { useSortQueryOptions as UseRocketChatSortQueryOptions } from 'rc/client/hooks/useSortQueryOptions.ts?kit-original';

export const useSortQueryOptions: typeof UseRocketChatSortQueryOptions = () => ({ sort: { lm: -1 } });
