// Calls off (lane CALL, C5): without the call app's address in the host config no call can start or be joined, so the call
// card (Rocket.Chat's own `VideoConfMessage`) shows its state without the Join button. A stylesheet, not an edit of the
// card: the card stays Rocket.Chat's, the primary button of a conference card is its Join.
import { getSource } from './adapter/bridge.ts';

export const startCallOff = (doc: Document = document): void => {
	let on = false;
	try {
		on = !!getSource().meetUrl();
	} catch {
		return; // no bridge: the kit's own startup reports it
	}
	if (on) return;
	const style = doc.createElement('style');
	style.setAttribute('data-kit-call-off', '');
	style.textContent = '[rcx-videoconf-message-block] .rcx-button--primary, .rcx-videoconf-message-block .rcx-button--primary { display: none !important; }';
	(doc.head ?? doc.documentElement).appendChild(style);
};
