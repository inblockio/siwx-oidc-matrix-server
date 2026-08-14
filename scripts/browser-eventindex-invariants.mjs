#!/usr/bin/env node
/**
 * Invariant tests for the browser EventIndex crypto + search helpers.
 *
 * These re-state the algorithms in
 * patches/element-web/browser-eventindex.patch
 * (BrowserEventIndexManager.ts) so they can run without the Element tree.
 * If a test here fails, the patch copy is wrong or drifted.
 *
 * Run: node --test scripts/browser-eventindex-invariants.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const HKDF_INFO = "inblock-ew-eventindex-v1";

function tokenize(text) {
    if (!text) return [];
    return text
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length > 0);
}

function replacedEventId(ev) {
    const rel = ev.content?.["m.relates_to"];
    if (rel && rel.rel_type === "m.replace" && typeof rel.event_id === "string" && rel.event_id.length > 0) {
        return rel.event_id;
    }
    return null;
}

function extractSearchText(ev) {
    if (ev.type === "m.room.name") return ev.content?.name ?? "";
    if (ev.type === "m.room.topic") return ev.content?.topic ?? "";
    const neu = ev.content?.["m.new_content"];
    if (neu && typeof neu.body === "string") return neu.body;
    return ev.content?.body ?? "";
}

function bytesToB64(bytes) {
    return Buffer.from(bytes).toString("base64");
}

function b64ToBytes(b64) {
    return new Uint8Array(Buffer.from(b64, "base64"));
}

async function deriveDek(pickleKey, salt, userId, deviceId) {
    const ikm = new TextEncoder().encode(pickleKey);
    const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    ikm.fill(0);
    const info = new TextEncoder().encode(`${HKDF_INFO}|${userId}|${deviceId}`);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

async function encryptJson(dek, value, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        pt,
    );
    pt.fill(0);
    return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

async function decryptJson(dek, blob, aad) {
    const iv = b64ToBytes(blob.iv);
    const ct = b64ToBytes(blob.ct);
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        dek,
        ct,
    );
    return JSON.parse(new TextDecoder().decode(pt));
}

function andSearch(events, term) {
    const tokens = tokenize(term);
    const inverted = new Map();
    for (const ev of events) {
        for (const tok of tokenize(extractSearchText(ev))) {
            if (!inverted.has(tok)) inverted.set(tok, new Set());
            inverted.get(tok).add(ev.event_id);
        }
    }
    let ids = null;
    for (const tok of tokens) {
        const hit = inverted.get(tok) ?? new Set();
        ids = ids === null ? new Set(hit) : new Set([...ids].filter((id) => hit.has(id)));
    }
    return ids ?? new Set();
}

test("I1 ciphertext at rest is not plaintext JSON", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const dek = await deriveDek("session-pickle", salt, "@alice:hs", "DEV");
    const blob = await encryptJson(dek, { body: "attack at dawn" }, "@alice:hs|$e1");
    assert.equal(blob.ct.includes("attack"), false);
    assert.equal(Buffer.from(blob.ct, "base64").toString("utf8").includes("attack"), false);
    const out = await decryptJson(dek, blob, "@alice:hs|$e1");
    assert.equal(out.body, "attack at dawn");
});

test("I2 leftover ciphertext is inert without the pickle key", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const dek = await deriveDek("pickle-A", salt, "@alice:hs", "DEV");
    const blob = await encryptJson(dek, { body: "private" }, "@alice:hs|$e1");
    const other = await deriveDek("pickle-B", salt, "@alice:hs", "DEV");
    await assert.rejects(() => decryptJson(other, blob, "@alice:hs|$e1"));
});

test("I2 AAD binds ciphertext to user+event", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const dek = await deriveDek("pickle-A", salt, "@alice:hs", "DEV");
    const blob = await encryptJson(dek, { body: "private" }, "@alice:hs|$e1");
    await assert.rejects(() => decryptJson(dek, blob, "@bob:hs|$e1"));
});

test("I5 DEK is non-extractable", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const dek = await deriveDek("pickle-A", salt, "@alice:hs", "DEV");
    assert.equal(dek.extractable, false);
    await assert.rejects(() => crypto.subtle.exportKey("raw", dek));
});

test("I6 only Seshat event classes contribute search text", () => {
    assert.equal(extractSearchText({ type: "m.room.message", content: { body: "hi" } }), "hi");
    assert.equal(extractSearchText({ type: "m.room.name", content: { name: "n" } }), "n");
    assert.equal(extractSearchText({ type: "m.room.topic", content: { topic: "t" } }), "t");
    assert.equal(extractSearchText({ type: "m.room.member", content: { membership: "join" } }), "");
    assert.equal(extractSearchText({ type: "m.room.encrypted", content: { ciphertext: "x" } }), "");
});

test("UX3 m.replace search hits the new body under the original event id", () => {
    const original = {
        event_id: "$orig",
        type: "m.room.message",
        content: { body: "old wording xyz" },
    };
    const edit = {
        event_id: "$edit",
        type: "m.room.message",
        content: {
            body: "* new wording abc",
            "m.new_content": { body: "new wording abc", msgtype: "m.text" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
        },
    };
    assert.equal(replacedEventId(edit), "$orig");
    const stored = {
        event_id: replacedEventId(edit),
        type: "m.room.message",
        content: edit.content["m.new_content"],
    };
    assert.equal(andSearch([stored], "abc").has("$orig"), true);
    assert.equal(andSearch([stored], "xyz").has("$orig"), false);
    assert.equal(andSearch([original], "xyz").has("$orig"), true);
});

test("AND query requires every token", () => {
    const events = [
        { event_id: "$1", type: "m.room.message", content: { body: "alpha beta" } },
        { event_id: "$2", type: "m.room.message", content: { body: "alpha gamma" } },
    ];
    assert.deepEqual([...andSearch(events, "alpha beta")].sort(), ["$1"]);
    assert.deepEqual([...andSearch(events, "alpha")].sort(), ["$1", "$2"]);
});

test("tokenize does not keep punctuation that would leak as a second index", () => {
    assert.deepEqual(tokenize("Hello, WORLD!"), ["hello", "world"]);
});
