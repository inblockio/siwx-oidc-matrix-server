// Stands in for `ee/` modules (never bundled, REQ-0008). Apps functions are N/A.
import { naError } from './adapter/recorder.ts';

export class Utilities {
	static getI18nKeyForApp(key: string, appId: string): string {
		return `app-${appId}.${key}`;
	}

	static curl(): never {
		throw naError('ee', 'Utilities.curl');
	}
}
