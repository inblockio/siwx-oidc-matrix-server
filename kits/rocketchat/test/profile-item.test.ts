// M10 W4: the user menu's "Profile" item opens Element's settings dialog. Expected values are the task's, not the implementation's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { BridgeSource } from '../src/adapter/source.ts';
import { fixtureBridge } from '../src/adapter/fixture-bridge.ts';
import { toUser } from '../src/adapter/map.ts';
import { SETTINGS_TAB_BY_ITEM, withProfileHandler, type SettingsTab } from '../src/profile-item.ts';

type Click = (() => void) | undefined;
const menu = (own: () => void, other: () => void) => [
	{ title: 'Account', items: [{ id: 'about', onClick: other }, { id: 'profile', onClick: own }, { id: 'admin', onClick: other }] },
	{ title: 'Switch view', items: [{ id: 'switch-view-stock', onClick: other }] },
	{ items: [{ id: 'logout', onClick: other }] },
];

describe('profile item (W4)', () => {
	it('replaces only the profile click; every other item, title and section stays as it was', () => {
		const own = () => undefined;
		const other = () => undefined;
		const open = () => undefined;
		const input = menu(own, other);
		const out = withProfileHandler(input, open);
		assert.equal(out.length, 3);
		assert.deepEqual(out.map((s) => s.items.map((i) => i.id)), [['about', 'profile', 'admin'], ['switch-view-stock'], ['logout']]);
		let asked: SettingsTab | undefined;
		const out2 = withProfileHandler(input, (tab) => (asked = tab));
		(out2[0].items[1].onClick as Click)?.();
		assert.equal(asked, 'account');
		assert.notEqual(out[0].items[1].onClick, own, 'Rocket.Chat\'s own handler is replaced');
		assert.equal(out[0].items[0].onClick, other);
		assert.equal(out[0].items[2].onClick, other);
		assert.equal(out[1].items[0].onClick, other);
		assert.equal(out[2].items[0].onClick, other);
		assert.equal(out[0].title, 'Account');
		// The input is not mutated.
		assert.equal(input[0].items[1].onClick, own);
	});

	it('a menu without a profile item (an element the kit does not render) comes back unchanged', () => {
		const other = () => undefined;
		const out = withProfileHandler([{ items: [{ id: 'logout', onClick: other }] }], () => undefined);
		assert.deepEqual(out, [{ items: [{ id: 'logout', onClick: other }] }]);
	});

	it('clicking Profile asks the host for Element\'s settings dialog; a refusal is the caller\'s catch, the other items never open it', async () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const errors: unknown[] = [];
		const open = () => void src.openUserSettings().catch((error) => errors.push(error));
		const sections = withProfileHandler(menu(() => assert.fail('Rocket.Chat\'s own handler ran'), () => undefined), open);
		(sections[0].items[0].onClick as Click)?.();
		(sections[2].items[0].onClick as Click)?.();
		assert.equal(b.userSettingsOpens, 0);
		(sections[0].items[1].onClick as Click)?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(b.userSettingsOpens, 1);
		assert.deepEqual(errors, []);
		b.userSettingsResult = Object.assign(new Error('Element could not open its settings'), { code: 'failed' });
		(sections[0].items[1].onClick as Click)?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(errors.length, 1);
		assert.equal((errors[0] as { message: string }).message, 'Element could not open its settings');
	});

	it('the user menu hook applies the handler to the original menu (the swap is not unit-loadable: its source is the check)', () => {
		const source = readFileSync(new URL('../src/user-menu.tsx', import.meta.url), 'utf8');
		assert.match(source, /withProfileHandler\(\s*withoutEmptyStatusSection\(useRocketChatUserMenu\(user\)\)/);
		assert.match(source, /getSource\(\)\.openUserSettings\(\{ tab \}\)\.catch\(/);
		assert.match(source, /getSource\(\)\.settingsTabs\(\)/);
	});
});

// M11 Y2 (D43): Preferences, Accessibility and Feature preview open Element's settings dialog on their own tab. Expected values are the task's.
type Row = { id: string; onClick: () => void; content?: unknown };
type Menu = { title?: string; items: Row[] };

describe('settings tabs (M11 Y2)', () => {
	const rc = () => void assert.fail('Rocket.Chat\'s own handler ran');
	const accountSection = () => [{ title: 'Account', items: [{ id: 'feature-preview', onClick: rc }, { id: 'profile', onClick: rc }, { id: 'preferences', onClick: rc }, { id: 'accessibility', onClick: rc }] }];
	// What Rocket.Chat 8.9.0 lists in the Account section while its `Accounts_AllowFeaturePreview` setting is off (the kit never sets it): no Feature preview item.
	const rcSection = (): Menu[] => [{ title: 'Account', items: [{ id: 'profile', onClick: rc }, { id: 'preferences', onClick: rc }, { id: 'accessibility', onClick: rc }] }];
	const ids = (sections: { items: { id?: string }[] }[]) => sections[0].items.map((i) => i.id);
	const click = (sections: { items: { id?: string; onClick?: unknown }[] }[], id: string) => (sections[0].items.find((i) => i.id === id)?.onClick as Click)?.();
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it('maps profile to account, preferences to preferences, accessibility to appearance (Element has no accessibility tab), feature-preview to labs', () => {
		assert.deepEqual(SETTINGS_TAB_BY_ITEM, { profile: 'account', preferences: 'preferences', accessibility: 'appearance', 'feature-preview': 'labs' });
	});

	it('below bridge version 5 Preferences, Accessibility and Feature preview are dropped (no path: hidden, D38), Profile keeps its M10 wiring', () => {
		const b = Object.assign(fixtureBridge(), { version: 4 as 2 | 3 | 4 | 5, settingsLabsTab: true });
		const src = new BridgeSource(b);
		assert.deepEqual(src.settingsTabs(), { tabs: false, labs: false }, 'a version 4 host never gets the tab, whatever it reports');
		const opened: SettingsTab[] = [];
		const out = withProfileHandler(accountSection(), (tab) => opened.push(tab), src.settingsTabs());
		assert.deepEqual(ids(out), ['profile']);
		click(out, 'profile');
		assert.deepEqual(opened, ['account']);
		// Also with the default offer (no host information), and a claimed Labs tab without the tabs inserts nothing.
		assert.deepEqual(ids(withProfileHandler(accountSection(), () => undefined)), ['profile']);
		assert.deepEqual(ids(withProfileHandler(rcSection(), () => undefined, { tabs: false, labs: true })), ['profile']);
	});

	it('on version 5 or newer Preferences and Accessibility are wired; Feature preview is absent while Element lists no Labs tab, and inserted right after Accessibility (once) when it does', () => {
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		assert.equal(b.version >= 5, true);
		assert.deepEqual(src.settingsTabs(), { tabs: true, labs: false }, 'a host that reports no settingsLabsTab');
		b.settingsLabsTab = false;
		assert.deepEqual(src.settingsTabs(), { tabs: true, labs: false });
		const without = withProfileHandler(rcSection(), () => undefined, src.settingsTabs());
		assert.deepEqual(ids(without), ['profile', 'preferences', 'accessibility']);
		const rcDropped = withProfileHandler(accountSection(), () => undefined, src.settingsTabs());
		assert.deepEqual(ids(rcDropped), ['profile', 'preferences', 'accessibility'], 'Rocket.Chat\'s own Feature preview item is dropped too while there is no Labs tab');
		b.settingsLabsTab = true;
		assert.deepEqual(src.settingsTabs(), { tabs: true, labs: true });
		const withLabs = withProfileHandler(rcSection(), () => undefined, src.settingsTabs());
		assert.deepEqual(ids(withLabs), ['profile', 'preferences', 'accessibility', 'feature-preview']);
		assert.notEqual(withLabs[0].items[3].onClick, rc);
	});

	it('Rocket.Chat\'s own Feature preview item is rewritten, not doubled', () => {
		const out = withProfileHandler(accountSection(), () => undefined, { tabs: true, labs: true });
		assert.deepEqual(ids(out), ['feature-preview', 'profile', 'preferences', 'accessibility'], 'the item stays where Rocket.Chat put it');
		assert.equal(ids(out).filter((id) => id === 'feature-preview').length, 1);
		assert.notEqual(out[0].items[0].onClick, rc);
	});

	it('the inserted Feature preview item: Account section only, after Accessibility, Rocket.Chat\'s icon and the given label, opens the labs tab; the input is not mutated', () => {
		const input: Menu[] = [...rcSection(), { title: 'Switch view', items: [{ id: 'switch-view-stock', onClick: rc }] }, { items: [{ id: 'logout', onClick: rc }] }];
		const opened: SettingsTab[] = [];
		const out = withProfileHandler(input, (tab) => opened.push(tab), { tabs: true, labs: true }, 'Vorschau');
		assert.deepEqual(out.map((s) => s.items.map((i) => i.id)), [['profile', 'preferences', 'accessibility', 'feature-preview'], ['switch-view-stock'], ['logout']]);
		const inserted = out[0].items[3] as { id: string; icon: string; content: string; onClick: () => void };
		assert.deepEqual({ id: inserted.id, icon: inserted.icon, content: inserted.content }, { id: 'feature-preview', icon: 'flask', content: 'Vorschau' });
		inserted.onClick();
		assert.deepEqual(opened, ['labs']);
		assert.deepEqual(input[0].items.map((i) => i.id), ['profile', 'preferences', 'accessibility'], 'the input is not mutated');
		assert.equal(withProfileHandler(rcSection(), () => undefined, { tabs: true, labs: true })[0].items[3].content, 'Feature preview', 'default label');
		// A menu without any Account item (an element the kit does not render) gets nothing inserted.
		assert.deepEqual(withProfileHandler([{ items: [{ id: 'logout', onClick: rc }] }], () => undefined, { tabs: true, labs: true }), [{ items: [{ id: 'logout', onClick: rc }] }]);
	});

	it('a host without openUserSettings offers no tab', () => {
		const b = fixtureBridge();
		(b as { openUserSettings?: unknown }).openUserSettings = undefined;
		assert.deepEqual(new BridgeSource(b).settingsTabs(), { tabs: false, labs: false });
	});

	it('each item asks the host for its own tab, and no other item opens the dialog', async () => {
		const b = fixtureBridge();
		b.settingsLabsTab = true;
		const src = new BridgeSource(b);
		const errors: unknown[] = [];
		const open = (tab: SettingsTab) => void src.openUserSettings({ tab }).catch((error) => errors.push(error));
		const sections = withProfileHandler<Menu>([...rcSection(), { items: [{ id: 'logout', onClick: () => undefined }] }], open, src.settingsTabs());
		(sections[1].items[0].onClick as Click)?.();
		await settle();
		assert.equal(b.userSettingsOpens, 0);
		for (const id of ['profile', 'preferences', 'accessibility', 'feature-preview']) {
			click(sections, id);
			await settle();
		}
		assert.deepEqual(b.userSettingsTabs, ['account', 'preferences', 'appearance', 'labs']);
		assert.deepEqual(errors, []);
	});

	it('openUserSettings without options reaches the host without a tab (the Account tab, as in M10)', async () => {
		const b = fixtureBridge();
		assert.deepEqual(await new BridgeSource(b).openUserSettings(), { status: 'done' });
		assert.deepEqual(b.userSettingsTabs, [undefined]);
	});

	it('the host\'s refusal of a tab (labs while Element lists none) is Rocket.Chat\'s error toast with the host\'s message, nothing else opens', async () => {
		const b = fixtureBridge();
		b.settingsLabsTab = true;
		b.userSettingsResult = Object.assign(new Error('Element lists no Labs tab'), { code: 'failed' });
		const src = new BridgeSource(b);
		const toasts: { type: string; message: unknown }[] = [];
		const open = (tab: SettingsTab) => void src.openUserSettings({ tab }).catch((error) => toasts.push({ type: 'error', message: error }));
		click(withProfileHandler(rcSection(), open, src.settingsTabs()), 'feature-preview');
		await settle();
		assert.equal(toasts.length, 1);
		assert.equal(toasts[0].type, 'error');
		assert.equal((toasts[0].message as { message: string }).message, 'Element lists no Labs tab');
		assert.deepEqual(b.userSettingsTabs, ['labs']);
	});

	it('the user carries the Labs flag, so a flip of settingsLabsTab is a user change and the menu re-renders', () => {
		const me = { userId: '@alice:example.org', displayName: 'Alice' };
		assert.equal((toUser({ ...me, settingsLabsTab: true }) as unknown as { settingsLabsTab?: boolean }).settingsLabsTab, true);
		assert.equal('settingsLabsTab' in toUser({ ...me, settingsLabsTab: false }), false);
		assert.equal('settingsLabsTab' in toUser(me), false);
		const b = fixtureBridge();
		const src = new BridgeSource(b);
		const seen: string[] = [];
		src.onChange((c) => seen.push(`${c.op}:${c.kind}`));
		b.settingsLabsTab = true;
		b.emit({ kind: 'me' });
		assert.deepEqual(seen, ['changed:user']);
		b.emit({ kind: 'me' });
		assert.deepEqual(seen, ['changed:user'], 'no flip, no change');
		b.settingsLabsTab = false;
		b.emit({ kind: 'me' });
		assert.deepEqual(seen, ['changed:user', 'changed:user']);
	});
});
