// Local copy of the host contract (Element apps/web/src/client-views/types.ts, bridge version 2, extended by version 3 (M9) and version 4 (M10: openDirectory, `peek`; additive) and version 5 (M11 Y2: `openUserSettings({ tab })`, `ViewMe.settingsLabsTab`; additive) and version 6 (M12 Z3: `showMedia`; additive) and version 7 (M13 U6: `quickReact`; additive) and version 8 (M14 K4: `openUserInfo`; additive), branch element-views/m5-a3-actionbar).
// The kit never imports Element; keep this file identical in shape to the host's.

/*
 * The contract between Element and a client view ("kit"): an alternative UI that Element hosts after login.
 * Plain data only, no Element or matrix-js-sdk types, so a kit can be built and tested without either.
 * Every value comes from a shipped view-model snapshot; a field without a view-model source stays undefined.
 */

/** A room as the room list view-model shows it. */
export interface ViewRoom {
    id: string;
    name: string;
    avatarUrl?: string;
    unreadCount: number;
    mentionCount: number;
    isDirect: boolean;
    /** position in the room list snapshot, 0 = top */
    order: number;
    /**
     * `invite` = the room list item's snapshot flags the room as invited (`notification.invited`); absent or `join` =
     * joined. An invite has no inviter field (no view-model source).
     */
    membership?: "join" | "invite";
    /** The room is a favourite (the room list item's `isFavourite`, the `m.favourite` room tag). */
    isFavourite: boolean;
    /**
     * M6 B1: the room's custom section (the item's `sections` entry with `isSelected`): the opaque tag of one of `sections()`.
     * Absent for a room in none; exclusive with `isFavourite`. A host without the field (before M6) sets none.
     */
    section?: string;
    /**
     * Element offers "mark as unread" for the room (the item's `canMarkAsUnread`): it shows nothing unread and is not
     * archived. For a joined room, false means it already shows unread, by a count, an activity or a mark.
     */
    canMarkAsUnread: boolean;
    /**
     * Element shows the room as unread (the item's `canMarkAsRead`: a count, an activity or a "marked unread" mark). False for
     * a local room (a new DM before its first message) and for a left room's preview. The unread look reads this, not
     * `canMarkAsUnread`. A host of the first version 2 builds has no such field (the unread look then stays off).
     */
    showsUnread?: boolean;
    /** The room's notification level (the item's `roomNotifState`). */
    notificationLevel: ViewNotificationLevel;
}

/** M6 B1: a custom room-list section (Element's `RoomList.CustomSectionData`), `tag` opaque, `order` Element's (0 = top). */
export interface ViewSection {
    tag: string;
    name: string;
    order: number;
}

/** The notification levels of a room, as the room list item view-model's `RoomNotifState` names them. */
export type ViewNotificationLevel = "all_messages" | "all_messages_loud" | "mentions_only" | "mute";


/**
 * A call, on the message that roots it (the `org.matrix.msc4075.rtc.notification` event Element draws its call card
 * from). Filled only from the call-card view-models: `RootCallTileViewModel` decides ongoing or ended, the Room/Dm
 * ongoing tile view-models give the participants, `DurationViewModel` the running time, the Room/Dm tombstone ones the
 * end and, in a DM, the decline. The host reads no MatrixRTC state of its own.
 */
export interface ViewCall {
    /** The call's id: the root event's id (`ViewMessage.id`). */
    callId: string;
    /** `RootCallTileViewModel.tileType`: an ongoing tile is "ongoing", a tombstone tile is "ended". */
    state: "ongoing" | "ended";
    /** The call's intent (the tile view-models read it from the notification event: `m.call.intent`). */
    callType: "video" | "voice";
    /** A DM tile (`ongoing-call-dm`, `tombstone-call-dm`), else a room tile. */
    isDm: boolean;
    /** The face pile of the ongoing tile (Element shows at most three). Empty when ended. */
    participants: ViewCallParticipant[];
    /** The room tile's `totalParticipants` (everyone in the call, not only the face pile). Ongoing room tile only. */
    participantCount?: number;
    /** When the call started: the notification event's `origin_server_ts` (the tombstone view-models give no time other than a formatted string). */
    startedTs: number;
    /** `DurationViewModel.duration` in seconds. Ongoing only; ended calls have no duration in any view-model. */
    durationSeconds?: number;
    /** The DM tombstone tile's `isCallDeclined`. Only a DM tombstone has it. */
    declined?: boolean;
}

export interface ViewCallParticipant {
    userId: string;
    name: string;
    avatarUrl?: string;
}

/** A message as the timeline, event tile and body view-models show it. */
export interface ViewMessage {
    id: string;
    roomId: string;
    senderId: string;
    senderName: string;
    senderAvatarUrl?: string;
    ts: number;
    /** plain text, always a string (emoji-only included) */
    body: string;
    /** sanitized HTML if the view-model exposes it */
    formattedBody?: string;
    kind: "text" | "notice" | "emote" | "other";
    /**
     * Trust signals from the E2E view-models (REQ-0007). Absent for a message without any.
     * `pending`/`failed`: the message has no readable body (`body` is empty), `text` is the reason Element shows.
     * `decrypted`: the body is readable; `warning` is the padlock text when the padlock marks the message.
     */
    e2e?: ViewE2e;
    /** The message this one replies to, from the reply tile view-model, once it is loaded. */
    replyTo?: ViewReply;
    /** Reactions from the reactions row button view-models, in Element's order. Absent for a message without any. */
    reactions?: ViewReaction[];
    /** The thread this message roots, from the thread summary view-model. Absent for a message without replies. */
    thread?: ViewThread;
    /**
     * Own messages: the transaction id the message was sent with (`getTxnId()`, else the echo's
     * `unsigned.transaction_id`). A kit that sent it with a txnId of its own recognises its optimistic copy by it.
     */
    txnId?: string;
    /**
     * Own message that Element's edit rule allows editing (`canEditContent`: sent, not redacted, not an edit itself, own,
     * `m.text` or `m.emote` with a body). A kit offers its edit control only when this is true. Absent = not editable.
     */
    canEdit?: boolean;
    /**
     * M6 B2: the message is pinned (`m.room.pinned_events` of its room lists it, `PinningUtils.isPinned`). Absent = not pinned.
     * Refreshed when the room's pinned list changes, also from another client.
     */
    pinned?: boolean;
    /**
     * M6 B2: Element offers Pin (or Unpin, when pinned) on this message to the user: the action bar's own rule
     * (`PinningUtils.canPin` or `canUnpin`: the user may send `m.room.pinned_events` and the event is pinnable). A kit offers
     * its pin control only when this is true. Absent = not offered.
     */
    canPin?: boolean;
    /**
     * M14 K6: Element's "Copy Markdown" is offered for this message (the registry patch's `canCopyMarkdown`: a text-like
     * message whose body can be converted back to Markdown; not an image, a redacted or an undecrypted one). A kit shows its
     * "Copy Markdown" item only when this is true. Absent = not offered.
     */
    canCopyMarkdown?: boolean;
    /**
     * Element's permalink for this event, as its own "Copy link" / Share gives it (`RoomPermalinkCreator.forEvent`:
     * matrix.to or the configured permalink prefix, with `via` servers). Absent for a deleted message.
     */
    permalink?: string;
    /**
     * Element offers a download for this message (the Download action bar button's rule: a media message whose content is
     * actionable, `isContentActionable` and `MediaEventHelper.isEligible`). False or absent for a text message, a
     * redacted one and one still waiting for its key; the module permission hint of the action bar view-model is not
     * read here, `download` reports it as `forbidden`.
     */
    canDownload?: boolean;
    /** The message has been edited (the edited marker's rule: a replacement event exists). */
    edited?: true;
    /** When the latest replacement was sent (ms since epoch; `ts` stays the original's). Only with `edited`, when known. */
    editedTs?: number;
    /**
     * The message was deleted (redacted). Its `body` is then Element's own redacted text ("Message deleted"); a kit may
     * drop or tombstone the row.
     */
    redacted?: true;
    /** The image, file, video or audio of a media message, from its body view-model. Absent for any other message. */
    media?: ViewMedia;
    /**
     * The link previews of the message, from the URL preview group view-model, in Element's order. Absent when Element
     * shows none: previews hidden by the setting (room or encrypted-room default), by the user, or no link.
     */
    urlPreviews?: ViewUrlPreview[];
    /**
     * Set on the root event of a call (`kind` is "other", `body` is empty): the call card Element draws. See `ViewCall`.
     * Version 2, additive: a kit that does not know the field gets a message with an empty body and no content.
     */
    call?: ViewCall;
    /**
     * Set on the entry of an `m.room.encryption` state event (`kind` is "other", `body` is empty): the line Element's
     * encryption tile draws, from its `EncryptionEventViewModel`. `state` is that view-model's state lower-cased
     * (`enabled_local` = the pre-send local chat started from the kit, which has no server room yet); `userName` only
     * for `enabled_dm` (the partner's name). The state can change after the entry first appears, a `timeline` event
     * follows. M12 Z4, additive: a host without the field never sets it.
     */
    encryption?: ViewEncryption;
    /**
     * Set on the stub of a message whose lifetime ran out (disappearing messages; `body` is "", `kind` is "other",
     * `senderName` is ""). A kit removes the message with that id as it removes a redacted one, and shows nothing for an id
     * it never knew. The host sends the stub because a message missing from a snapshot has only left the window.
     * Room retention M4 (D15), additive: a host without the field never sets it.
     */
    expired?: true;
    /**
     * Set on the entry of an `m.room.retention` state event (`kind` is "other", `body` is empty): the system line for a
     * change of the room's disappearing-messages setting. `text` is preformatted and translated by the host and does not
     * contain the sender's name (the kit's system line prints it); a kit shows it as plain text. Room retention M4
     * (D15), additive: a host without the field never sets it.
     */
    retention?: { text: string };
}

/** The state of an encryption event line (see `ViewMessage.encryption`). */
export interface ViewEncryption {
    state: "enabled" | "enabled_dm" | "enabled_local" | "changed" | "disable_attempt" | "unsupported";
    userName?: string;
}

/**
 * A link preview as the URL preview group view-model shows it. `image.url` is the thumbnail it fetched (absent when
 * Element's media-visibility setting hides media); `ogUrl` is the page's own canonical URL, if it differs from `link`.
 */
export interface ViewUrlPreview {
    link: string;
    title: string;
    siteName: string;
    description?: string;
    siteIcon?: string;
    ogUrl?: string;
    author?: string;
    image?: { url: string; width?: number; height?: number; alt?: string };
}

/**
 * A thread summary: `replyCount` as the summary view-model counts it, `lastReplyTs` in ms (the root's own time when the
 * latest reply is not loaded), `participantIds` = distinct senders of the replies, `lastReply.text` empty while that
 * event or its edit is unreadable.
 */
export interface ViewThread {
    replyCount: number;
    lastReplyTs: number;
    lastReply?: { eventId: string; senderId: string; text: string };
    participantIds: string[];
}

/** One reaction key: `count` = distinct senders, `mine` = the user reacted with it (not redacted). */
export interface ViewReaction {
    key: string;
    count: number;
    mine: boolean;
    senderIds: string[];
}

/** A replied-to message: `text` is its plain body without its own reply fallback, empty while it is unreadable. */
export interface ViewReply {
    eventId: string;
    senderId: string;
    senderName: string;
    text: string;
}

/**
 * A media body as the image, file, video or audio body view-model shows it. URLs are plain strings the kit's frame can load
 * (authenticated media goes through Element's service worker, encrypted media is the view-model's decrypted blob URL).
 * `state` "hidden" = Element's media-visibility setting hides it (`label` = the reveal text Element shows),
 * "error" = Element shows its error (`label` = that text), "loading" = no URL yet.
 * `name` is the label Element shows: the image alt, the video title, or the file or audio label (which already
 * carries the size). `width` and `height` are the frame size the view-model suggests for an image or video.
 * An audio message (a voice message included) has no body view-model here: Element's one decodes the whole file to
 * play it, so `url` is the media helper's (the homeserver URL, or the decrypted blob URL) and the kit's frame plays it.
 */
export interface ViewMedia {
    kind: "image" | "file" | "video" | "audio";
    state: "ready" | "loading" | "hidden" | "error";
    url?: string;
    thumbnailUrl?: string;
    name: string;
    width?: number;
    height?: number;
    label?: string;
}

/**
 * A thread summary: `replyCount` as the summary view-model counts it, `lastReplyTs` in ms (the root's own time when the
 * latest reply is not loaded), `participantIds` = distinct senders of the replies, `lastReply.text` empty while that
 * event or its edit is unreadable.
 */
export interface ViewThread {
    replyCount: number;
    lastReplyTs: number;
    lastReply?: { eventId: string; senderId: string; text: string };
    participantIds: string[];
}

/** One reaction key: `count` = distinct senders, `mine` = the user reacted with it (not redacted). */
export interface ViewReaction {
    key: string;
    count: number;
    mine: boolean;
    senderIds: string[];
}

/** A replied-to message: `text` is its plain body without its own reply fallback, empty while it is unreadable. */
export interface ViewReply {
    eventId: string;
    senderId: string;
    senderName: string;
    text: string;
}

export type ViewE2e = { state: "pending" | "failed"; text: string } | { state: "decrypted"; warning?: string };

/** M11 Y2 (bridge version 5): the tabs of Element's settings dialog `openUserSettings` can open on. */
export type ViewSettingsTab = "account" | "preferences" | "appearance" | "labs";

/** The signed-in user as the user menu view-model shows them. */
export interface ViewMe {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    /**
     * M10 W6: the room list's sort as Element's device setting `RoomList.preferredSorting` holds it. `unread-first` has no
     * Rocket.Chat radio, so the kit shows neither radio checked. Absent: the host does not report it.
     */
    roomSort?: "recent" | "alphabetical" | "unread-first";
    /**
     * M11 Y2 (bridge version 5): Element lists a Labs tab in its settings dialog (Element's own predicate: `show_labs_settings`,
     * developer mode, or any beta). Only then does `openUserSettings({ tab: "labs" })` open it; the kit offers "Feature preview" on it.
     * Absent: the host does not report it (version 4 or older), the kit offers no such item. A `me` change fires when it flips.
     */
    settingsLabsTab?: boolean;
}

export type ViewConnection = "online" | "connecting" | "offline";

/**
 * What an action resolved with. `done`: the effect happened (the server answered, the snapshot changed, the dialog
 * returned). `cancelled`: the user dismissed Element's own dialog or picker (never an error).
 * `peek` (M10, `openDirectory`): the roomId is a world-readable room Element only previews, not in `rooms()` (the user did not join).
 */
export type ActionOutcome =
    | { status: "done"; roomId?: string; eventId?: string; section?: string; peek?: boolean }
    | { status: "cancelled" };

export type ClientViewActionErrorCode =
    "unknown_room" | "unknown_event" | "forbidden" | "network" | "unsupported" | "failed";

/** What a rejected action carries: a code a kit maps to its own error, and Element's message. */
export interface ClientViewActionError extends Error {
    readonly code: ClientViewActionErrorCode;
}

/** Where a kit's control sits, in page coordinates (the kit's frame covers the page from its origin). */
export interface ViewAnchor {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** What `loadOlder` reports: the messages it brought in, and why no further page can follow. */
export interface LoadOlderResult {
    /** Events that newly entered the loaded window. */
    added: number;
    /** The room's creation event is in the window: there is nothing older. */
    atStart: boolean;
    /** The window is within one page of its size limit: older history is out of reach (loading it would drop the live end). */
    atLimit: boolean;
    /** The event ids this page added to the loaded window (a kit tells history from a live arrival by them, not by position or time). */
    ids?: string[];
}

/** What the host hands a kit, as `window.__clientViewBridge`. */
export interface ClientViewBridge {
    readonly version: 2 | 3 | 4 | 5 | 6 | 7 | 8;
    me(): ViewMe;
    rooms(): ViewRoom[];
    /** starts (idempotent) and returns the timeline of a room */
    timeline(roomId: string): ViewMessage[];
    markRead(roomId: string): void;
    connection(): ViewConnection;
    /** every selectable view, "stock" included */
    views(): { id: string; name: string }[];
    /** "stock" = Element's own UI */
    switchTo(viewId: string): void;
    /**
     * The address of the call app from the host config (`client_views_meet_url`), or undefined when the instance has
     * none: the kit then offers no call. Optional: a host without it is a host without calls.
     */
    meetUrl?(): string | undefined;
    /**
     * Sends a text message and resolves `done` + `eventId` once the server returns it. `opts.txnId` is the transaction
     * id the sent event carries (`ViewMessage.txnId`); `opts.replyTo` is the event id of the replied message. In a local
     * (not yet created) room the first send creates the room and `roomId` is the real one. Without `opts.markdown` it is
     * plain `m.text`. With `markdown: true` (M7 E1) the content is what Element's composer sends for that CommonMark
     * text (`format` + `formatted_body` only when the Markdown yields HTML); `mentions` is E2's and ignored when empty.
     * Interim (D16 / D31): Element's own client call, until a composer send view-model ships.
     */
    sendText(roomId: string, text: string, opts?: { txnId?: string; replyTo?: string; markdown?: boolean; mentions?: string[] }): Promise<ActionOutcome>;
    /**
     * M7 E2: the members Element's composer offers for "@<query>" in a room (its user autocomplete; `query` without the "@").
     * Rejects `unknown_room` for an unknown room. Interim (D31), with `mentions` of sendText / editText.
     */
    mentionCandidates(roomId: string, query: string): Promise<{ userId: string; displayName: string; avatarUrl?: string }[]>;
    /**
     * Loads the next page of older messages of a room and resolves when the page is in (the room's `timeline` has
     * changed by then). Concurrent calls for a room share one load. Backed by the timeline view-model's
     * `onStartReached`. Rejects `unknown_room` for a room the bridge does not know, `failed` if the room's first window
     * never loads.
     */
    loadOlder(roomId: string): Promise<LoadOlderResult>;
    onChange(cb: (e: { kind: "rooms" | "timeline" | "me" | "connection"; roomId?: string }) => void): () => void;
    /**
     * A5: joins a room by id or `#alias:server` (no `ViewRoom`); `done` + the joined room's id. `unknown_room` for an
     * address that does not exist, `forbidden` when the server refuses. Interim (D16).
     */
    join(roomIdOrAlias: string): Promise<ActionOutcome>;
    /** A5: accepts an invite (the join of that room). Interim (D16). */
    acceptInvite(roomId: string): Promise<ActionOutcome>;
    /** A5: declines an invite (`client.leave`). Interim (D16). */
    declineInvite(roomId: string): Promise<ActionOutcome>;
    /**
     * A6: Element's create-room dialog (`RoomListViewModel.createRoom`). `done` + the new room's id once Element has
     * created it, `cancelled` when the dialog closes without creating, `failed` on Element's error dialog or after 15 s.
     */
    createRoom(): Promise<ActionOutcome>;
    /**
     * A6: Element's start-chat dialog (`RoomListViewModel.createChatRoom`). `done` + the chat's room id: an existing DM,
     * or the local room of a new one (listed in `rooms()` until its first `sendText` creates the real room).
     * `cancelled` when the dialog closes without a chat.
     */
    createChat(): Promise<ActionOutcome>;
    /**
     * A7: Element's leave confirm (`RoomListItemViewModel.onLeaveRoom`). `done` once the user is no longer in the room,
     * `cancelled` when the confirm says no, `unsupported` for an archived room, `failed` when the leave did not happen.
     */
    leave(roomId: string): Promise<ActionOutcome>;
    /**
     * A11: edits the user's own message `eventId` (the Matrix event id) to the plain text `text`. Resolves `done` with
     * the ORIGINAL event id once the homeserver holds the replacement. `forbidden` for another user's message or one
     * Element does not let the user edit (`ViewMessage.canEdit`), `unknown_event` when it cannot be loaded, `failed`
     * for a blank text (nothing is sent). Interim (D16/D20): entry through the action bar view-model's `onEditClick`,
     * the replacement send is Element's own client call.
     */
    editText(roomId: string, eventId: string, text: string, opts?: { markdown?: boolean; mentions?: string[] }): Promise<ActionOutcome>;
    /**
     * M6 B2: pins (`on`) or unpins the message `eventId` (the Matrix event id): `m.room.pinned_events` of the room. `done` once
     * the homeserver accepted the new list and the room's state shows it (`ViewMessage.pinned` equals `on`); already as asked is
     * `done` without a call. `forbidden` when Pin is not offered (`ViewMessage.canPin` false) or the homeserver refuses,
     * `unknown_event` / `unknown_room`, `network` when the state did not show in time (the write may still apply). A refused
     * write changes nothing locally. Calls for one room run one after the other. Backed by the action bar view-model's
     * `onPinClick` (D22; Element's `PinningUtils.pinOrUnpinEvent`, copy-fixed in the hook set).
     */
    setPinned(roomId: string, eventId: string, on: boolean): Promise<ActionOutcome>;
    /**
     * A12: deletes (redacts) the user's own message `eventId`. `done` once the homeserver accepted the redaction;
     * `forbidden` for another user's message (also for a user with redact power), `unknown_event` when it cannot be
     * loaded. The kit asks for the confirmation. Interim (D16/D20): Element's own client call.
     */
    redact(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * B7: downloads the file, image, video or audio of the message `eventId` the way Element's Download action bar button
     * does (`EventTileActionBarViewModel.onDownloadClick`): it waits until the event is decrypted, then Element fetches
     * and decrypts the file and saves it with its own downloader. `done` once Element's click settled, which is also the
     * case when the fetch or decryption failed: Element's own error dialog shows then and the kit shows nothing of its
     * own. `unknown_room` / `unknown_event` for what the client cannot load, `unsupported` for a message without media,
     * `failed` when it stays undecrypted, `forbidden` when the view-model does not offer the download.
     */
    download(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * M12 Z3 (bridge version 6, additive; a kit on an older host feature-checks `typeof bridge.showMedia === "function"`):
     * reveals the hidden image or video of the message `eventId` the way Element's own Show / preview button does (the shared
     * view-model action; the choice is device-level, nothing is written to the server). The id is checked against the room's
     * current timeline snapshot first. `done` once the message no longer reads `media.state: "hidden"` (also when it already
     * did; nothing is written then); the media itself arrives through the next `timeline` snapshot. `unknown_room` /
     * `unknown_event` for what the client cannot load, `unsupported` for a body that is not hidden media, `failed` after 5 s
     * with the reveal kept (no rollback).
     */
    showMedia?(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * M13 U6 (bridge version 7, additive; a kit on an older host feature-checks `typeof bridge.quickReact === "function"`):
     * Element's composer quick reaction (`+:emoji:`, `SendMessageComposer.sendQuickReaction`) run on the host, which picks the
     * target itself: walking the room's live timeline newest first, the first `m.room.message` event (a failed decrypt, whose
     * clear type reads `m.room.message` / `m.bad.encrypted`, included; state events, reactions and a message still waiting for
     * its key skipped). `done` with that event's `eventId` once the reaction is sent (also when the user already reacted with
     * `key` there: nothing is written, Element never toggles off); `done` without an `eventId` when the room has no such event
     * (nothing reacted, as stock). `unknown_room`, `forbidden` (the server refused), `network`, `failed` as `react`. The write is
     * awaited (stock fires and forgets). Interim: mirrors the 12 lines of the private stock method (not callable without a mounted composer).
     */
    quickReact?(roomId: string, key: string): Promise<ActionOutcome>;
    /**
     * A10: marks the room unread (the room list item's `onMarkAsUnread`: the room account data `m.marked_unread`). `done`
     * once the homeserver holds it, also for a room that already shows unread; `unsupported` for an invite or an archived
     * room, `unknown_room` for a room the list does not hold.
     */
    markUnread(roomId: string): Promise<ActionOutcome>;
    /**
     * A10: favourites or unfavourites the room (the item's `onToggleFavorite`, called only when `isFavourite` differs: the
     * `m.favourite` tag). `done` once the homeserver holds it and the room's tags show it; `failed` when it refuses (Element's
     * error dialog shows too).
     */
    setFavourite(roomId: string, on: boolean): Promise<ActionOutcome>;
    /** M6 B1: the custom sections in Element's order (the item's `sections`); a change fires `onChange` with kind `rooms`. Absent before M6. */
    sections?(): ViewSection[];
    /** M6 B1: puts the room into the custom section `tag`, or out of its custom section with `null` (the item's `onToggleSection` / `onRemoveFromSection`). `done` once the room's tags show it. */
    setSection(roomId: string, tag: string | null): Promise<ActionOutcome>;
    /** M6 B1: Element's create-section dialog (D17), the room preselected when given. `done` + `section` (the new tag), or `cancelled`. */
    createSection(roomId?: string): Promise<ActionOutcome>;
    /**
     * M10 W2, additive (feature-check `typeof bridge.editSection === "function"`): Element's own create-section dialog in edit
     * mode for the section `tag` (`RoomListStoreV3.editSection`, D17). `done` + `section` (= `tag`) for any returned name (also an
     * unchanged name with room changes, and a cancel at the rooms step, which still commits the rename); `cancelled` when closed at
     * the name step; `failed` for a tag not in `sections()`; `network` when the write times out.
     */
    editSection?(tag: string): Promise<ActionOutcome>;
    /**
     * M10 W3, additive (feature-check `typeof bridge.removeSection === "function"`): Element's own `RemoveSectionDialog` for the
     * section `tag` (`RoomListStoreV3.removeSection`, D17). `done` + `section` (= `tag`) once `sections()` no longer lists it (its
     * rooms then arrive in `rooms()` without `section`); `cancelled` when declined; `failed` for a tag not in `sections()`;
     * `network` when the section is still listed after the wait.
     */
    removeSection?(tag: string): Promise<ActionOutcome>;
    /**
     * M11 Y3, additive (feature-check `typeof bridge.moveSection === "function"`, no `version` bump): moves the custom section
     * `tag` one place up or down among the custom sections, as Element's drag does (`RoomListStoreV3.reorderSection`, no dialog).
     * `done` + `section` (= `tag`) once the stored order and `sections()` show it (15 s); `failed` for a tag `sections()` does not
     * list, for the first custom going up or the last going down (no neighbour) and for a refused write; `network` when the store
     * did not answer in time or `sections()` did not follow (N10, as `removeSection`). Only the relative order of the customs moves.
     */
    moveSection?(tag: string, direction: "up" | "down"): Promise<ActionOutcome>;
    /**
     * A10: sets the room's notification level (the item's `onSetRoomNotifState`: push rules). `done` once the homeserver
     * holds it; `failed` when it refuses (the echoed level is dropped, the level stays what the homeserver holds).
     */
    setNotificationLevel(roomId: string, level: ViewNotificationLevel): Promise<ActionOutcome>;
    /**
     * A8: uploads files into a room through Element's own upload view-model (`RoomUploadViewModel.initiateViaInputFiles`).
     * Without `files`, Element's file picker opens now (call it inside the user's click); with them (from the kit's own
     * picker) they are re-wrapped as files of Element's realm. Element's `UploadConfirmDialog` is the one confirmation and
     * its error dialog shows on a refusal. `done` once every confirmed file is on the homeserver as a message,
     * `cancelled` when the picker or the confirm is dismissed, `failed` when an upload fails, `forbidden` when the user may
     * not send in the room, `unknown_room` for a room the client does not hold.
     */
    upload(roomId: string, files?: File[]): Promise<ActionOutcome>;
    /**
     * A9: signs the user out the way Element's own sign-out button does: `LogoutDialog` (key backup check) or, without
     * crypto, a direct sign-out. `cancelled` when the dialog is dismissed (still signed in). On success the page leaves the
     * session and unmounts the kit, so `done` (after Element announced `on_logged_out`) is normally not observable; `failed`
     * when Element does not sign out within 30 s. Interim (D16): there is no sign-out action on `UserMenuViewModel`.
     */
    logout(): Promise<ActionOutcome>;
    /** A2: toggles the user's reaction `key` on a message (the reactions row button view-model's click). */
    react(roomId: string, eventId: string, key: string): Promise<ActionOutcome>;
    /** A2: Element's own reaction picker over the kit; `done` when it closes, a chosen reaction arrives as a change. */
    openReactionPicker(roomId: string, eventId: string, anchor: ViewAnchor): Promise<ActionOutcome>;
    /**
     * E3: Element's own forward dialog over the kit; `done` when it closes (the dialog sends each copy and shows its result
     * itself, the kit keeps no state from it). A jump through the dialog's room name answers `done` + that room's `roomId`,
     * which the kit follows to; otherwise `roomId` is the message's room. `unsupported` for content Element does not
     * forward (not actionable, a poll). Interim (D31): awaits a forward action on a shared message view-model.
     */
    openForward(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * M10 W4 (additive, feature-check it): Element's own settings dialog on its Account tab (display name, avatar) over the kit;
     * `done` when it closes. Interim (D41): awaits an open-settings action on a shared user-menu view-model.
     * M11 Y2 (bridge version 5): `opts.tab` opens the dialog on that tab (absent: `account`, as before). `labs` while Element lists no
     * Labs tab (`ViewMe.settingsLabsTab` false) answers `failed` and dispatches nothing. A version 4 host ignores `opts`.
     */
    openUserSettings?(opts?: { tab?: ViewSettingsTab }): Promise<ActionOutcome>;
    /**
     * M10 W6 (additive, feature-check it): sets the room list's sort the way Element's room list header does
     * (`RoomListStoreV3.resort`; the kit keeps no sort of its own). `done` once the setting reads back the value, then a `rooms`
     * change (the new order) and a `me` change (`roomSort`) fire. `failed` when the room list store is not ready.
     * Interim (D41): awaits a sort action on a shared `RoomListHeaderViewModel`-style view-model.
     */
    setRoomSort?(option: "recent" | "alphabetical"): Promise<ActionOutcome>;
    /**
     * E5: Element's own View source dialog over the kit (the event id and the event JSON; decrypted and original for an encrypted
     * event); `done` when it closes. The dialog is read-only, so the kit keeps no state. `unknown_room` / `unknown_event` as v2.
     * Interim (D31): awaits a view-source action on a shared message view-model.
     */
    openViewSource(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * M7 E4: Element's own report dialog over the kit (`Action.OpenReportEventDialog`, as the message context menu opens
     * it). `done` when the dialog closes (a report sent, cancelled or dismissed alike: Element shows the result itself,
     * the kit keeps no state), `forbidden` for an own message (Element offers Report only on others'), `unknown_room` /
     * `unknown_event` for a message the bridge does not hold. Interim (D31): no report action on a shared view-model.
     */
    openReport(roomId: string, eventId: string): Promise<ActionOutcome>;
    /**
     * M8 T1: Element's own thread panel (`ThreadView`) over the kit, on the thread of `eventId` (the root, or a reply of a
     * thread: then its root's thread; root only, no highlight). `done` (roomId, eventId = the root) when the panel closes (its
     * close button, Escape, a later `openThread`, `closeThread`, the room left); Element's composer in the panel sends the thread
     * replies itself, so the kit keeps no state from it. `unknown_room` / `unknown_event` as v2, `unsupported` when Element offers
     * no thread for the event. Interim (D37): awaits a thread panel view-model.
     */
    openThread(roomId: string, eventId: string): Promise<ActionOutcome>;
    /** M8 T1: closes an open thread panel (its `openThread` resolves `done`); a no-op otherwise. The kit calls it when it leaves the room. */
    closeThread(): void;
    /**
     * M9 (bridge version 3), interim (D39): Element's own card in the host panel slot over the kit (replaces an open panel or
     * thread panel). `done` (`roomId`) when it closes (close button, Escape, a later open, `closePanel`, the room left, another
     * room opened from it, the bridge disposed). `unknown_room`; `unsupported` when Element offers no such card for the room.
     * Awaits a right-panel view-model.
     */
    openPanel(roomId: string, card: ViewPanelCard): Promise<ActionOutcome>;
    /**
     * M14 K4 (bridge version 8, additive; a kit on an older host feature-checks `typeof bridge.openUserInfo === "function"`):
     * Element's own user info of `userId` (a member of `roomId`) in the host panel slot, the MXID and under it the DID row.
     * Same slot and lifecycle as `openPanel`: `done` (`roomId`) when it closes. `unknown_room`; `unsupported` for a room not
     * joined, an empty user id or a user the room has no member object for. Awaits a right-panel view-model.
     */
    openUserInfo?(roomId: string, userId: string): Promise<ActionOutcome>;
    /**
     * M14 K6 (bridge version 8, additive; a kit on an older host feature-checks `typeof bridge.copyMarkdown === "function"`):
     * copies the Markdown of the message to the clipboard through Element's `eventToMarkdown` and `copyPlainTextToClipboard`,
     * in the call stack of the click (the clipboard needs the user gesture). `done` when the clipboard took it; `unknown_room`,
     * `unknown_event`; `unsupported` where `canCopyMarkdown` is not set; `failed` when the clipboard refused the text.
     */
    copyMarkdown?(roomId: string, eventId: string): Promise<ActionOutcome>;
    /** M9: closes whatever the slot shows (`closeThread` stays as an alias); a no-op otherwise. The kit calls it when it leaves the room. */
    closePanel(): void;
    /** M9: Element asked, from a panel, to show an event of the panel's room (the kit scrolls to it and highlights it). Returns the unsubscribe. */
    onJump(cb: (j: { roomId: string; eventId: string }) => void): () => void;
    /**
     * M10 W1 / W5 (version 4; a kit on an older host feature-checks `typeof bridge.openDirectory === 'function'`): Element's Spotlight
     * over the kit, to browse the server's public rooms (`filter: "rooms"`, the default; `Action.ViewRoomDirectory`) or search its
     * people (`filter: "people"`; `Action.OpenSpotlight` on the People filter), starting at `term`. Rooms: `done` + the room's id once it
     * is listed in `rooms()` (the pick joined it, or it already was), `done` + `peek: true` for a world-readable room Element only
     * previews (it is not in `rooms()`), `failed` when the join fails or the room is not listed within 15 s. People: `done` + the chat's
     * room id (an existing DM, or the local room of a new one, listed in `rooms()` like `createChat`'s). `cancelled` when the dialog
     * closes without a pick. Interim (D41): no shared directory view-model.
     */
    openDirectory(opts?: { term?: string; filter?: "rooms" | "people" }): Promise<ActionOutcome>;
    /**
     * M11 Y4 (a kit on a host without it feature-checks `typeof bridge.startDm === 'function'`): opens, or starts, the direct chat
     * with the user `userId` (a Matrix user id). `done` carries the DM room's `roomId` (an existing DM, or the local room of a new
     * one, listed in `rooms()` like `createChat`'s); `cancelled` when the user backs out; a host failure throws
     * `ClientViewActionError("failed", ...)`. Interim (D41): no shared direct-chat view-model.
     * M12 Z2 (additive, no version change): the optional `fromRoomId` is the room of the message the user replied to; a new chat is titled
     * with the name and avatar of that room's member (a host before M12 ignores the argument, then titles by the first room that names them).
     */
    startDm?(userId: string, fromRoomId?: string): Promise<ActionOutcome>;
    /** M9: Element asked, from a panel, to show another room (the kit navigates; the panel is closed). Returns the unsubscribe. */
    onRoomOpen(cb: (j: { roomId: string; eventId?: string }) => void): () => void;
}

/** M9: the cards the host panel slot shows (Element's room info, member list, file panel, pinned messages, message search). */
export type ViewPanelCard = "info" | "members" | "files" | "pinned" | "search";

/** A kit that runs in a same-origin iframe loaded from `url`. */
export interface ClientViewDescriptor {
    id: string;
    name: string;
    url: string;
}

/** The id of Element's own UI. */
export const STOCK_VIEW = "stock";

/** The property under which the host exposes the bridge, on its own window and on the kit's frame window. */
export const BRIDGE_GLOBAL = "__clientViewBridge";
