// Rocket.Chat routes on absolute paths (/home, /channel/<name>), but the kit's document lives at /kits/<id>/. If the
// frame's URL moved to /home, a reload inside the frame would load whatever the host serves there (Element, or a
// 404), never the kit (D8); a beforeunload fix-up does not help, a reload keeps the URL it started with. So the
// document URL never leaves the kit: Rocket.Chat's path lives in the hash (`/kits/<id>/index.html#/channel/x?q#h`),
// and the bundler hands Rocket.Chat's free `location` and `history` (its router) these virtual ones instead.
// This module must only use `window.location` / `window.history` (member expressions are not swapped).
const real = window.location;
const realHistory = window.history;

/** The kit document's own path, fixed at load. */
const kitPath = real.pathname;

type Parts = { pathname: string; search: string; hash: string };

/** Splits the real hash into Rocket.Chat's path, search and hash; no or a foreign hash = /home. */
export const parseHash = (realHash: string): Parts => {
	const h = realHash.startsWith('#/') && !realHash.startsWith('#//') ? realHash.slice(1) : '/home';
	const hashAt = h.indexOf('#');
	const beforeHash = hashAt < 0 ? h : h.slice(0, hashAt);
	const searchAt = beforeHash.indexOf('?');
	return {
		pathname: searchAt < 0 ? beforeHash : beforeHash.slice(0, searchAt),
		search: searchAt < 0 ? '' : beforeHash.slice(searchAt),
		hash: hashAt < 0 ? '' : h.slice(hashAt),
	};
};

const parts = (): Parts => parseHash(real.hash);
const virtualHref = (): string => {
	const p = parts();
	return `${real.origin}${p.pathname}${p.search}${p.hash}`;
};

/** A Rocket.Chat URL -> the real document URL; undefined for another origin. */
const toReal = (url: string | URL): string | undefined => {
	const u = new URL(String(url), virtualHref());
	if (u.origin !== real.origin) return undefined;
	return `${kitPath}#${u.pathname}${u.search}${u.hash}`;
};

/** Rocket.Chat's full-page navigations (e.g. an unhandled route) reload the kit at the new path, never leave it. */
const navigate = (url: string, replace: boolean): void => {
	const target = toReal(url);
	if (!target) {
		if (replace) real.replace(url);
		else real.assign(url);
		return;
	}
	if (replace) realHistory.replaceState(null, '', target);
	else realHistory.pushState(null, '', target);
	real.reload();
};

export const location = {
	get href() {
		return virtualHref();
	},
	set href(url: string) {
		navigate(url, false);
	},
	get origin() {
		return real.origin;
	},
	get protocol() {
		return real.protocol;
	},
	get host() {
		return real.host;
	},
	get hostname() {
		return real.hostname;
	},
	get port() {
		return real.port;
	},
	get pathname() {
		return parts().pathname;
	},
	get search() {
		return parts().search;
	},
	get hash() {
		return parts().hash;
	},
	assign: (url: string) => navigate(url, false),
	replace: (url: string) => navigate(url, true),
	reload: () => real.reload(),
	toString: () => virtualHref(),
};

export const history = {
	get length() {
		return realHistory.length;
	},
	get state() {
		return realHistory.state;
	},
	get scrollRestoration() {
		return realHistory.scrollRestoration;
	},
	set scrollRestoration(v: ScrollRestoration) {
		realHistory.scrollRestoration = v;
	},
	pushState: (state: unknown, title: string, url?: string | URL | null) => {
		if (url == null) return realHistory.pushState(state, title);
		const target = toReal(url);
		if (!target) throw new DOMException(`history.pushState: ${String(url)} is not same-origin`, 'SecurityError');
		realHistory.pushState(state, title, target);
	},
	replaceState: (state: unknown, title: string, url?: string | URL | null) => {
		if (url == null) return realHistory.replaceState(state, title);
		const target = toReal(url);
		if (!target) throw new DOMException(`history.replaceState: ${String(url)} is not same-origin`, 'SecurityError');
		realHistory.replaceState(state, title, target);
	},
	go: (delta?: number) => realHistory.go(delta),
	back: () => realHistory.back(),
	forward: () => realHistory.forward(),
};

/** Called once at boot: the document starts at the kit URL; with no Rocket.Chat path in the hash it starts at /home. */
export const enterRoutes = (): void => {
	if (!real.hash.startsWith('#/')) realHistory.replaceState(null, '', `${kitPath}#/home`);
};
