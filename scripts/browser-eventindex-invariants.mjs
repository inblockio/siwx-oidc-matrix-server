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

function foldText(text) {
    return text
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "");
}

function tokenize(text) {
    if (!text) return [];
    return foldText(text)
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

function stripHtml(s) {
    return s.replace(/<[^>]+>/g, " ");
}

function collectText(value, into) {
    if (typeof value === "string") {
        if (value.length > 0) into.push(value);
        return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.body === "string") into.push(value.body);
    if (typeof value.filename === "string") into.push(value.filename);
    if (typeof value.formatted_body === "string") into.push(stripHtml(value.formatted_body));
    if (value["m.caption"] !== undefined) collectText(value["m.caption"], into);
    if (value["org.matrix.msc1767.caption"] !== undefined) collectText(value["org.matrix.msc1767.caption"], into);
    const markup = value["m.markup"] ?? value["org.matrix.msc1767.markup"];
    if (Array.isArray(markup)) {
        for (const part of markup) collectText(part, into);
    }
}

function extractSearchText(ev) {
    if (ev.type === "m.room.name") return ev.content?.name ?? "";
    if (ev.type === "m.room.topic") return ev.content?.topic ?? "";
    const parts = [];
    collectText(ev.content, parts);
    if (ev.content?.["m.new_content"]) collectText(ev.content["m.new_content"], parts);
    return parts.filter((p) => p.length > 0).join(" ");
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

function lookupToken(inverted, token) {
    const out = new Set();
    const exact = inverted.get(token);
    if (exact) for (const id of exact) out.add(id);
    if (token.length >= 2) {
        for (const [idx, ids] of inverted) {
            if (idx !== token && idx.startsWith(token)) {
                for (const id of ids) out.add(id);
            }
        }
    }
    return out;
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
    let ids = tokens.length === 0 ? new Set() : null;
    for (const tok of tokens) {
        const hit = lookupToken(inverted, tok);
        ids = ids === null ? new Set(hit) : new Set([...ids].filter((id) => hit.has(id)));
        if (ids.size === 0) break;
    }
    if (!ids || ids.size === 0) {
        const folded = foldText(term).replace(/\s+/g, " ").trim();
        ids = new Set();
        if (folded.length >= 3) {
            for (const ev of events) {
                if (foldText(extractSearchText(ev)).includes(folded)) ids.add(ev.event_id);
            }
        }
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

test("fold accents so cafe matches café", () => {
    assert.deepEqual(tokenize("Café Zürich"), ["cafe", "zurich"]);
    const events = [{ event_id: "$1", type: "m.room.message", content: { body: "Meet at Café Zürich" } }];
    assert.equal(andSearch(events, "cafe zurich").has("$1"), true);
});

test("prefix every token of length >= 2", () => {
    const events = [{ event_id: "$1", type: "m.room.message", content: { body: "invoice payment received" } }];
    assert.equal(andSearch(events, "inv pay").has("$1"), true);
});

test("filename and caption are searchable; media bytes are not", () => {
    const file = {
        event_id: "$f",
        type: "m.room.message",
        content: { body: "image.jpg", filename: "quarterly-report.pdf", url: "mxc://s/a" },
    };
    assert.match(extractSearchText(file), /quarterly-report\.pdf/);
    assert.equal(andSearch([file], "quarterly-report").has("$f"), true);
    assert.equal(extractSearchText(file).includes("mxc://"), false);
});

test("substring fallback for mid-word queries of length >= 3", () => {
    const events = [{ event_id: "$1", type: "m.room.message", content: { body: "please send the invoice" } }];
    assert.equal(andSearch(events, "oice").has("$1"), true);
    assert.equal(andSearch(events, "ce").has("$1"), false);
});
