// Records emoji names with Rocket.Chat's `addRecentEmoji` one per render. Its `addFrequentEmojis` computes the new list
// from the state its closure closed over, so two calls through one closure in one pass keep only the last emoji. Names
// are queued in state and an effect hands over the head: the render that follows carries the updated closure.
import { useEffect, useState } from 'react';

export const useRecentEmojiQueue = (addRecentEmoji: (name: string) => void, subscribe: (cb: (name: string) => void) => () => void): void => {
	const [queue, setQueue] = useState<string[]>([]);
	useEffect(() => subscribe((name) => setQueue((q) => [...q, name])), [subscribe]);
	useEffect(() => {
		if (!queue.length) return;
		// Both updates (the provider's and the queue's) land in one render, so the next name sees the new closure.
		addRecentEmoji(queue[0]);
		setQueue((q) => q.slice(1));
	}, [queue, addRecentEmoji]);
};
