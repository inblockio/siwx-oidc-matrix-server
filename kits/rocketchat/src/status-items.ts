// Bundler swap of Rocket.Chat's user-menu status items (patch class "D41 hide"): online, away, busy, offline, custom status
// and status visibility have no Element equivalent, so the menu lists none of them. Returning nothing also skips the
// original's `/v1/custom-user-status.list` request.
import type { GenericMenuItemProps } from '@rocket.chat/ui-client';

export const useStatusItems = (): GenericMenuItemProps[] => [];
