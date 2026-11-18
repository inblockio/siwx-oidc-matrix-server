// Rocket.Chat runs its user-data sync from its Meteor login hook (client/startup/startup.ts); the kit runs the same
// function once, for the user the source names, so `useMainReady` opens.
import { synchronizeUserData } from 'rc/client/lib/userData';

import { getSource } from './adapter/bridge.ts';

void synchronizeUserData(getSource().me._id);
