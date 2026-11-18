// Kit entry: Rocket.Chat's own startup for rooms, routes and the app root, never its Meteor startup or login.
import './runtime-config';
import './bootstrap';
import 'rc/app/theme/client';
import 'rc/client/lib/rooms/roomTypes';
import 'rc/client/startup/routes';
import 'rc/client/startup/appRoot';
import './user-sync';
import { startCallOff } from './call-off.ts';
import { installDownloadLinks } from './download-link.ts';
import { startOverlay } from './overlay.ts';
import { startPanelEvents } from './panel-events.ts';
import { watchThreadRoute } from './thread-route.ts';
import { router } from 'rc/client/providers/RouterProvider';
import { MessageTypes } from '@rocket.chat/message-types';
import { registerRetentionType } from './retention-type.ts';

registerRetentionType(MessageTypes);
startOverlay();
startCallOff();
installDownloadLinks(document);
watchThreadRoute(router);
startPanelEvents(router);
