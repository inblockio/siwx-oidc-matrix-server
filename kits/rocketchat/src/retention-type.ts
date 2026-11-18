// M4 (decision D15): Rocket.Chat's system-message type for a change of the room's disappearing-messages setting. The line
// reads "<sender's display name> <text>" (its SystemMessage prints the name, then `messageType.text(...)`); the host's text
// is preformatted and translated and has no name in it, so the type's text is the message text as it is. No existing
// Rocket.Chat type takes a preformatted sentence. Registered from kit source through the public `registerType`, nothing is
// changed inside Rocket.Chat's packages; `entry.ts` calls this with the package's singleton.
export const RETENTION_TYPE_ID = 'room_retention_changed';

type Registry = { registerType(options: never): void };

export const registerRetentionType = (registry: { registerType(options: never): void } | Registry): void => {
	// The id union of Rocket.Chat's types is closed, hence the cast.
	registry.registerType({ id: RETENTION_TYPE_ID, system: true, text: (_t: unknown, message: { msg?: string }) => message.msg ?? '' } as never);
};
