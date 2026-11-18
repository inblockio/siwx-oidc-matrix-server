// Replaces every `meteor/*` import. Reads return inert values; calls that would reach a server throw N/A (H5).
import { getSource } from './adapter/bridge.ts';
import { naError } from './adapter/recorder.ts';

const noop = () => undefined;
const stop = () => ({ stop: noop });
const thrower = (name: string) => () => {
	throw naError('meteor', name);
};

export const Meteor = {
	Device: { isDesktop: () => false },
	isClient: true,
	isServer: false,
	isCordova: false,
	isDevelopment: false,
	isProduction: true,
	settings: { public: {} },
	_localStorage: window.localStorage,
	absoluteUrl: Object.assign((path = '') => `${window.location.origin}/${path.replace(/^\//, '')}`, {
		defaultOptions: { rootUrl: window.location.origin },
	}),
	userId: () => null,
	user: () => null,
	loggingIn: () => false,
	// The host's connection state; Rocket.Chat shows its own "waiting for server" bar while it is not online.
	status: () => {
		const c = getSource().connection();
		if (c === 'online') return { connected: true, status: 'connected', retryCount: 0 };
		return { connected: false, status: c === 'connecting' ? 'connecting' : 'waiting', retryCount: 0 };
	},
	startup: (fn: () => void) => fn(),
	defer: (fn: () => void) => setTimeout(fn, 0),
	methods: noop,
	subscribe: (name: string) => {
		throw naError('meteor.subscribe', name);
	},
	call: (name: string) => {
		throw naError('meteor.call', name);
	},
	apply: (name: string) => {
		throw naError('meteor.apply', name);
	},
	callAsync: (name: string) => Promise.reject(naError('meteor.callAsync', name)),
	loginWithToken: thrower('loginWithToken'),
	loginWithPassword: thrower('loginWithPassword'),
	loginWithLDAP: thrower('loginWithLDAP'),
	loginWithCrowd: thrower('loginWithCrowd'),
	// A9: Rocket.Chat's own call for every logout (the user menu's "Log out" included): Element's sign-out, its LogoutDialog
	// decides. The kit never ends the session itself. Returns the host's answer (a dismissed dialog is `cancelled`); on success
	// the host unmounts the kit with the session.
	logout: (callback?: (error?: unknown) => void) =>
		getSource().logout().then(
			(outcome) => (callback?.(), outcome),
			(error) => (callback?.(error), Promise.reject(error)),
		),
	disconnect: thrower('disconnect'),
	reconnect: thrower('reconnect'),
	Error: class MeteorError extends Error {
		error: string;
		reason?: string;
		details?: unknown;
		constructor(error: string, reason?: string, details?: unknown) {
			super(reason ?? error);
			this.error = error;
			this.reason = reason;
			this.details = details;
		}
	},
	connection: {
		_stream: { on: noop },
		_outstandingMethodBlocks: [] as unknown[],
		setUserId: noop,
		subscribe: (name: string) => {
			throw naError('meteor.connection.subscribe', name);
		},
	},
	users: {},
};

export const DDPCommon = { parseDDP: () => undefined, stringifyDDP: () => '' };
export const DDP = { connect: thrower('DDP.connect') };

export const Tracker = {
	autorun: stop,
	nonreactive: <T>(fn: () => T) => fn(),
	afterFlush: (fn: () => void) => setTimeout(fn, 0),
	Dependency: class {
		depend = noop;
		changed = noop;
	},
};

export const Accounts = {
	onLogin: stop,
	onLogout: stop,
	onLoginFailure: stop,
	loggingIn: () => false,
	callLoginMethod: thrower('Accounts.callLoginMethod'),
	ConfigError: class ConfigError extends Error {},
	oauth: { registerService: noop, serviceNames: () => [], credentialRequestCompleteHandler: () => noop },
	_storedLoginToken: () => null,
	connection: undefined,
};

export const OAuth = {
	registerService: noop,
	launchLogin: thrower('OAuth.launchLogin'),
	_redirectUri: () => '',
	_stateParam: () => '',
	_loginStyle: () => 'popup',
	_retrieveCredentialSecret: () => null,
	_credentialSecretKey: '',
	showPopup: thrower('OAuth.showPopup'),
};

export const Mongo = { Collection: class {} };
export const Random = { id: () => Math.random().toString(36).slice(2, 19), secret: () => Math.random().toString(36).slice(2) };
export const ReactiveVar = class<T> {
	private value: T;

	constructor(value: T) {
		this.value = value;
	}
	get() {
		return this.value;
	}
	set(value: T) {
		this.value = value;
	}
};
export const Facebook = { requestCredential: thrower('Facebook') };
export const Google = { requestCredential: thrower('Google') };
export const Twitter = { requestCredential: thrower('Twitter') };
export const MeteorDeveloperAccounts = { requestCredential: thrower('MeteorDeveloperAccounts') };
export default Meteor;
