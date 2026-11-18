// M8 T1: the router hook that closes the thread panel when the route leaves its room.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { watchThreadRoute } from '../src/thread-route.ts';

describe('watchThreadRoute', () => {
	it('hands the route\'s rid and name to the source on every route change and stops when unsubscribed', () => {
		let params: Record<string, string | undefined> = { rid: 'A' };
		let fire: () => void = () => undefined;
		let subscribed = true;
		const router = {
			subscribeToRouteChange: (cb: () => void) => {
				fire = cb;
				return () => {
					subscribed = false;
				};
			},
			getRouteParameters: () => params,
		};
		const seen: { rid?: string; name?: string }[] = [];
		const stop = watchThreadRoute(router, () => ({ routeChanged: (p) => void seen.push(p) }));
		fire();
		params = { name: 'general', tab: 'thread' };
		fire();
		params = {};
		fire();
		assert.deepEqual(seen, [{ rid: 'A', name: undefined }, { rid: undefined, name: 'general' }, { rid: undefined, name: undefined }]);
		stop();
		assert.equal(subscribed, false);
	});

	it('survives a source that is not there yet', () => {
		let fire: () => void = () => undefined;
		watchThreadRoute({ subscribeToRouteChange: (cb) => ((fire = cb), () => undefined), getRouteParameters: () => ({}) }, () => {
			throw new Error('no bridge');
		});
		fire();
	});
});
