// Runs before any Rocket.Chat module: the signed-in user comes from the bridge, not from a Meteor login.
import { setStoredItem, STORAGE_KEYS } from 'rc/client/lib/sdk/storage';
import { dispatchToastMessage } from 'rc/client/lib/toast';
import { userIdStore } from 'rc/client/lib/user';
import { Rooms, Subscriptions, Users } from 'rc/client/stores';

import { getSource } from './adapter/bridge.ts';
import { loginToken } from './adapter/map.ts';
import { setCachedIds, setComposerKeeper, setJumpFailed, setRestoreComposer, setRoomOpener } from './adapter/sdk.ts';
import { composerHolds, restoreComposerText, saveRoomDraft } from './composer-restore.ts';
import './reaction-names.ts';
import { openRoom } from './room-opener.ts';
import { enterRoutes } from './reload.ts';

enterRoutes();
const { me } = getSource();
setStoredItem(STORAGE_KEYS.LOGIN_TOKEN, loginToken(me._id));
setRoomOpener(openRoom);
setCachedIds('rooms', () => Rooms.state.records.keys());
setCachedIds('subscriptions', () => Subscriptions.state.records.keys());
setJumpFailed((message) => dispatchToastMessage({ type: 'error', message }));
setRestoreComposer((rid, text) => restoreComposerText(rid, text));
setComposerKeeper((rid, text) => composerHolds(rid, text), (rid, text) => saveRoomDraft(rid, text));
setStoredItem(STORAGE_KEYS.USER_ID, me._id);
Users.state.store(me);
userIdStore.setState(me._id);
