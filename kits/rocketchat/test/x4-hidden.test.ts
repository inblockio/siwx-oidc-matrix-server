// M12 X4 (D41, D45): the connection bar's Connect button is removed, and so is the composer's Share location (D45, G1 = b).
// The document viewer is a row split: Rocket.Chat renders one only inside its Desktop app, which the kit never defines.
// Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HIDE_ACTIONS } from '../src/hide-actions.ts';

const RC_ROOT = join(homedir(), '.cache/element-views-track/rocket.chat');
const RC_BAR = join(RC_ROOT, 'apps/meteor/client/components/connectionStatus/ConnectionStatusBar.tsx');
const RC_TOOLBAR = join(RC_ROOT, 'apps/meteor/client/views/room/composer/messageBox/MessageBoxActionsToolbar/MessageBoxActionsToolbar.tsx');
const RC_LOCATION = join(RC_ROOT, 'apps/meteor/client/views/room/composer/messageBox/MessageBoxActionsToolbar/hooks/useShareLocationAction.tsx');
const RC_FILE = join(RC_ROOT, 'apps/meteor/client/components/message/content/attachments/file/GenericFileAttachment.tsx');

const filesUnder = (dir: string): string[] => {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) found.push(...filesUnder(full));
		else found.push(full);
	}
	return found;
};

describe('webpack swaps', () => {
	const webpack = readFileSync(new URL('../webpack.config.js', import.meta.url), 'utf8');
	const swaps = [...webpack.matchAll(/replaceFile\(\/(.+?)\/,\s*src\('([^']+)'\)\)/g)].map((match) => ({
		re: new RegExp(match[1]),
		file: match[2],
	}));

	it('swaps ConnectionStatusBar for the copy without the Connect button', () => {
		const path = 'apps/meteor/client/components/connectionStatus/ConnectionStatusBar.tsx';
		const hits = swaps.filter((swap) => swap.re.test(path)).map((swap) => swap.file);
		assert.deepEqual(hits, ['connection-status-bar.tsx']);
		assert.equal(existsSync(new URL('../src/connection-status-bar.tsx', import.meta.url)), true);
	});

	it('keeps the bar text and the countdown, and drops the button', () => {
		const source = readFileSync(new URL('../src/connection-status-bar.tsx', import.meta.url), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\/\/.*$/gm, '');
		// The countdown names contain the substring "reconnect". The removed name is the handler.
		const scanned = source.replaceAll('useReconnectCountdown', '').replaceAll('meteor_status_reconnect_in', '').replaceAll('reconnectCountdown', '');
		for (const gone of ['Button', 'onClick', 'reconnect', 'rcx-connection-status-bar--action', "Connect'"]) {
			assert.equal(scanned.includes(gone), false, gone);
		}
		for (const kept of ['useConnectionStatus', 'useReconnectCountdown', 'meteor_status', 'meteor_status_reconnect_in', "role='alert'", 'export default']) {
			assert.equal(source.includes(kept), true, kept);
		}
	});
});

describe('Rocket.Chat still has the button and the desktop viewer', () => {
	it('keeps the Connect button and openDocumentViewer in the Rocket.Chat checkout', (t) => {
		if (!existsSync(RC_ROOT)) {
			t.skip('Rocket.Chat checkout is absent');
			return;
		}
		const bar = readFileSync(RC_BAR, 'utf8');
		assert.equal(bar.includes('rcx-connection-status-bar--action'), true);
		assert.equal(bar.includes('onClick={reconnect}'), true);
		const attachment = readFileSync(RC_FILE, 'utf8');
		assert.equal(attachment.includes('window.RocketChatDesktop?.openDocumentViewer'), true);
	});
});

describe('the kit source', () => {
	it('assigns no document viewer', () => {
		const root = new URL('../src/', import.meta.url);
		for (const file of filesUnder(root.pathname)) {
			assert.equal(readFileSync(file, 'utf8').includes('openDocumentViewer'), false, file);
		}
	});
});

describe('D45 hides Share location', () => {
	it('lists share-location in the composer toolbox, after the three earlier ids, and leaves the other toolboxes', () => {
		assert.deepEqual(HIDE_ACTIONS.composerToolbox, ['create-discussion', 'timestamp', 'webdav-add', 'share-location']);
		assert.deepEqual(HIDE_ACTIONS.roomToolbox, ['mentions', 'starred-messages', 'discussions']);
		assert.equal(HIDE_ACTIONS.messageToolbox.includes('share-location'), false);
	});

	it('uses the id Rocket.Chat filters by', (t) => {
		if (!existsSync(RC_ROOT)) {
			t.skip('Rocket.Chat checkout is absent');
			return;
		}
		assert.match(readFileSync(RC_LOCATION, 'utf8'), /id: 'share-location'/);
		assert.match(readFileSync(RC_TOOLBAR, 'utf8'), /!isHidden\(hiddenActions, shareLocationAction\)/);
	});
});
