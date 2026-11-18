// Bundler swap of `localforage` (patch reason class "privacy: no persistence"): Rocket.Chat's CachedStore keeps its rooms,
// subscriptions, permissions and settings in an IndexedDB named after the page URL, tagged with the user's MXID. Element's
// sign-out clears Element's own storage and unmounts this view, but never reaches that database, so it stayed on disk after
// a sign-out (found by the A9 journey). The view's data comes from the host's bridge snapshot on every start, so nothing is
// worth persisting: this keeps the cache in memory only, and removes the database an older build left behind.
const store = new Map<string, unknown>();

try {
	// Best effort: the database an earlier build of this view created (named by `document.baseURI`, as CachedStore configured it).
	indexedDB.deleteDatabase(document.baseURI);
} catch {
	// no IndexedDB here: nothing to remove
}

const localforage = {
	config: (): boolean => true,
	getItem: async <T>(key: string): Promise<T | null> => (store.has(key) ? (store.get(key) as T) : null),
	setItem: async <T>(key: string, value: T): Promise<T> => {
		store.set(key, value);
		return value;
	},
	removeItem: async (key: string): Promise<void> => void store.delete(key),
	clear: async (): Promise<void> => store.clear(),
};

export default localforage;
