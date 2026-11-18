// Replaces `client/lib/sdk/ddpSdk.ts`: no socket; the account is the Element user handed in by the bridge, the
// connection state is the bridge's.
import { getSource } from './bridge.ts';
import { naError } from './recorder.ts';

const off = () => undefined;
const ddp = {
	account: {
		onLogin: (cb: () => void) => {
			queueMicrotask(cb);
			return off;
		},
		onLogout: () => off,
		onPageLoadLogin: () => off,
		onEmailVerificationLink: () => off,
		uid: undefined as string | undefined,
		user: undefined,
		emit: off,
		loginWithToken: () => Promise.reject(naError('ddp', 'loginWithToken')),
	},
	client: {
		callAsync: (name: string) => Promise.reject(naError('ddp.callAsync', name)),
		onCollection: () => off,
		subscribe: (name: string) => {
			throw naError('ddp.subscribe', name);
		},
	},
	connection: {
		get status() {
			return getSource().connection() === 'online' ? 'connected' : 'connecting';
		},
		on: (_event: string, cb: () => void) => getSource().onConnection(cb),
		close: off,
	},
	storage: undefined,
};

export const getDdpSdk = () => ddp as any;
export const readStoredLoginToken = () => 'element-session';
export const ensureConnectedAndAuthenticated = async () => undefined;
export const clearStoredCredentials = () => undefined;
export const isAuthError = () => false;
export const adoptAccountFromMeteorLoginResult = () => undefined;
