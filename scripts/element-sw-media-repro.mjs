// Element Web service-worker media-auth reproduction harness (2026-09-28 RCA,
// patches/element-web/README.md entry 9). Drives a real Element deployment with
// headless Chromium persistent profiles (so the SW registration, IndexedDB and
// localStorage survive "closing the browser") and records, per run: the SW's own
// console ([ServiceWorker] /versions + serverSupportMap lines), SW-originated
// /versions and media requests (legacy vs /client/v1/media, status), token
// refreshes (status + expires_in only) and whether the image actually rendered.
// Never prints token values.
//
// Needs the siwx-oidc repo's Element e2e node_modules (Playwright) and mock wallet:
//   SIWX_E2E_DIR=~/siwx-oidc/e2e  (default)
// Modes (profileDir persists between calls; arm = shim | noshim | noE):
//   setup    log in with a throwaway did:pkh wallet, create a room, upload+send a PNG
//   reopen   wait until the stored access token is >=310 s old, reopen into the room
//   fresh    reopen without waiting (normal non-expired reopen)
//   live     stay open; at token age LIVE_TRIGGER_S (default 303) open the image room
//            (LIVE_STOP_SW=1 stops the SW first via CDP, == browser idle termination)
//   hard     shift-reload (uncontrolled page) and check guard (B) re-attaches the SW
//   loggedout  logged-out page: redirect to the OP, no page errors, no canary probe
// Env: ELEMENT_URL and SIWX_ORIGIN (required: the Element Web origin and the
// siwx-oidc origin of the deployment under test), TOKEN_DELAY_MS (delay the /token
// response: reproduces the prod ordering where the refresh lands after load+3 s),
// TRACE_SYNC=1, PRE_WAIT_S. Arms: noshim aborts sw-boot.js, noE disables only
// guard (E). Reopening a profile <30 s after its last close hits Element's own
// session lock ("open in another window"): leave a gap.
//
// Reproduction (pre-fix, dev 2026-09-28): live + LIVE_STOP_SW=1 poisoned 1/1 per arm (2 runs);
// reopen + TOKEN_DELAY_MS=4000 poisoned 2/2 shim, 0/2 noE, 0/2 noshim.
//
// PASS CRITERIA. The network instrument (requestfinished + req.serviceWorker()) MISSES
// the first requests of a cold service worker: Playwright attaches to a freshly started
// SW asynchronously, so its opening /versions probe and first media fetches can happen
// before any event is delivered. VERSIONS/MEDIA counts are therefore supporting
// evidence only, and "0 legacy 404s" alone never proves a clean run. A run passes on
// the SW's own console (swAnonRetry / swMediaRetry markers, and no
// `"supportsAuthedMedia":false` update) plus the image render state (imgsFirstLoaded).
// A live run that cannot hold its target token age exits non-zero and records nothing.
//
// CREDENTIALS AND CLEANUP. Each profileDir is a real Chromium profile holding a live
// session of a throwaway did:pkh account: an OIDC refresh token and the encrypted access
// token in IndexedDB, the pickle key, and the Matrix device. Treat profiles as secrets:
// keep them under ~/.cache (never /tmp, never a repo), never attach them to a report,
// and delete them when done (`rm -rf <profiles root>`). Each profile's meta.json records
// the account's userId; list them BEFORE deleting the profiles, then deactivate exactly
// those accounts through the dev admin path (never a real user). Result JSON files carry
// no token values (Bearer values are redacted, /token bodies reduced to status and
// expires_in).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const E2E = process.env.SIWX_E2E_DIR || path.join(os.homedir(), "siwx-oidc/e2e");
const { chromium } = await import(path.join(E2E, "element/node_modules/playwright/index.mjs"));
const { makeWallet, injectMockWallet } = await import(path.join(E2E, "browser/wallet-helper.mjs"));
import zlib from "node:zlib";

// No default target: this script signs in and creates accounts, rooms and
// uploads, so it runs only against a deployment that is named explicitly.
const ELEMENT_URL = process.env.ELEMENT_URL;
const SIWX_ORIGIN = process.env.SIWX_ORIGIN;
const [mode, profileDir, arm, label = mode] = process.argv.slice(2);
if (!ELEMENT_URL || !SIWX_ORIGIN || !mode || !profileDir || !["shim", "noshim", "noE"].includes(arm)) {
    console.error("usage: ELEMENT_URL=https://element.example.org SIWX_ORIGIN=https://siwx-oidc.example.org \\\n" +
        "  element-sw-media-repro.mjs setup|reopen|fresh|live|hard|loggedout <profileDir> shim|noshim|noE [label]");
    process.exit(2);
}
fs.mkdirSync(profileDir, { recursive: true });
const metaPath = path.join(profileDir, "meta.json");
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const log = [];
const out = (s) => {
    const line = `${ts()} ${s}`;
    log.push(line);
    console.log(line);
};

// 64x64 solid PNG (big enough that Element asks for a thumbnail).
function makePng(w = 64, h = 64) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([200, (x * 4) & 255, (y * 4) & 255], y * (w * 3 + 1) + 1 + x * 3);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

if (process.env.PRE_WAIT_S) await new Promise((r) => setTimeout(r, Number(process.env.PRE_WAIT_S) * 1000));
const ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
const results = { versions: [], media: [], token: [], clientApi401: [], swConsole: [] };

// Narrow route in BOTH arms so interception overhead is identical.
await ctx.route("**/sw-boot.js", async (route) => {
    if (arm === "noshim") return route.abort();
    if (arm === "noE") {
        // Serve the real shim with only guard (E) (the swprobe canary) disabled.
        const r = await route.fetch();
        const body = (await r.text()).replace("function armSwCanary() {", "function armSwCanary() { return;");
        if (!body.includes("function armSwCanary() { return;")) throw new Error("noE rewrite anchor missing");
        return route.fulfill({ response: r, body });
    }
    return route.continue();
});

if (process.env.TOKEN_DELAY_MS) {
    // Simulates a slow token refresh (slow boot / slow OP), i.e. the prod ordering where the
    // refresh lands after load+3s. Only delays the response; request/response are unmodified.
    await ctx.route(SIWX_ORIGIN + "/token", async (route) => {
        const r = await route.fetch();
        await new Promise((res) => setTimeout(res, Number(process.env.TOKEN_DELAY_MS)));
        return route.fulfill({ response: r });
    });
}
if (process.env.SW_OVERRIDE) {
    const body = fs.readFileSync(process.env.SW_OVERRIDE, "utf8");
    await ctx.route(ELEMENT_URL + "/sw.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
}
if (process.env.SHIM_OVERRIDE && arm === "shim") {
    const body = fs.readFileSync(process.env.SHIM_OVERRIDE, "utf8");
    await ctx.unroute("**/sw-boot.js");
    await ctx.route("**/sw-boot.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
}
const hookWorker = (w) => {
    out(`SW attached ${w.url().replace(ELEMENT_URL, "")}`);
    w.on("close", () => out("SW closed (terminated)"));
    w.on("console", (m) => {
        const t = m.text().replace(/(Bearer\s+)\S+/g, "$1<redacted>");
        results.swConsole.push(`${ts()} [${m.type()}] ${t.slice(0, 400)}`);
        if (/versions|serverSupportMap|SW:|PREVALIDATION/i.test(t)) out(`SWCONSOLE [${m.type()}] ${t.slice(0, 300)}`);
    });
};
ctx.serviceWorkers().forEach(hookWorker);
ctx.on("serviceworker", hookWorker);

ctx.on("requestfinished", async (req) => {
    const u = new URL(req.url());
    const resp = await req.response().catch(() => null);
    const st = resp ? resp.status() : "ERR";
    const fromSW = !!req.serviceWorker();
    const hasAuth = !!(await req.allHeaders().catch(() => ({})))["authorization"];
    if (u.pathname === "/_matrix/client/versions") {
        results.versions.push({ t: ts(), status: st, fromSW, hasAuth, q: u.search });
        out(`VERSIONS ${st} fromSW=${fromSW} auth=${hasAuth}${u.search}`);
    } else if (/^\/_matrix\/(media\/v3|client\/v1\/media)\/(download|thumbnail)/.test(u.pathname)) {
        const kind = u.pathname.startsWith("/_matrix/media/v3") ? "LEGACY" : "AUTHED";
        results.media.push({ t: ts(), status: st, kind, fromSW, hasAuth, p: u.pathname.split("/").slice(-1)[0] });
        out(`MEDIA ${kind} ${st} fromSW=${fromSW} auth=${hasAuth} ${u.pathname.replace(/^\/_matrix\//, "").slice(0, 70)}`);
    } else if (u.origin === SIWX_ORIGIN && /token/.test(u.pathname) && req.method() === "POST") {
        let body = {};
        try {
            body = await resp.json();
        } catch {}
        results.token.push({ t: ts(), status: st, expires_in: body.expires_in });
        out(`TOKEN ${u.pathname} ${st} expires_in=${body.expires_in}`);
    } else if (u.pathname.startsWith("/_matrix/client") && st === 401) {
        results.clientApi401.push({ t: ts(), p: u.pathname });
        out(`CLIENT401 ${u.pathname}`);
    }
});

const page = ctx.pages()[0] || (await ctx.newPage());
page.on("console", (m) => {
    const t = m.text();
    if (/sw-boot|ServiceWorker|SW:/i.test(t)) out(`PAGECONSOLE [${m.type()}] ${t.slice(0, 200)}`);
});

async function imageState() {
    return page.evaluate(() => {
        const imgs = [...document.querySelectorAll(".mx_RoomView_body img")].filter((i) => /_matrix|^blob:/.test(i.currentSrc || i.src));
        return imgs.map((i) => ({ loaded: i.complete && i.naturalWidth > 0, w: i.naturalWidth, src: (i.currentSrc || i.src).slice(0, 60) }));
    });
}

let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};

if (mode === "hard") {
    // Hard (shift) reload: page loads UNcontrolled; guard (B) must re-attach the SW once.
    await page.goto(`${ELEMENT_URL}/#/room/${meta.roomId}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mx_MatrixChat").waitFor({ timeout: 90_000 });
    await page.waitForTimeout(8000);
    const cdp = await ctx.newCDPSession(page);
    out("hard reload (ignoreCache)");
    await cdp.send("Page.reload", { ignoreCache: true });
    await page.waitForTimeout(2000);
    out(`controlled right after hard reload=${await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => "nav")}`);
    await page.waitForTimeout(16000);
    results.imagesFirst = await imageState();
    out(`controlled after guard B=${await page.evaluate(() => !!navigator.serviceWorker.controller)} images=${JSON.stringify(results.imagesFirst)}`);
} else if (mode === "loggedout") {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
    await page.goto(ELEMENT_URL, { waitUntil: "domcontentloaded" });
    const redirected = await page.waitForURL((u) => u.origin === SIWX_ORIGIN, { timeout: 30_000 }).then(() => true).catch(() => false);
    out(`logged-out: redirected to siwx=${redirected} pageerrors=${JSON.stringify(errors)} swprobe=${results.media.filter((m) => /swprobe/.test(m.p)).length}`);
} else if (mode === "live") {
    // Live-session scenario: stay logged in, let the access token expire while idle in a
    // text-only room, then open a room whose image has not been rendered yet.
    if (!meta.roomId) throw new Error("no meta; run setup first");
    ctx.on("serviceworker", () => out("SW (re)started"));
    await page.goto(ELEMENT_URL, { waitUntil: "domcontentloaded" });
    await page.locator(".mx_MatrixChat").waitFor({ timeout: 90_000 });
    // Make sure a fresh token was issued in THIS session (known t0), and park in a text room.
    const textRoom = meta.textRoomId || (await page.evaluate(async () => (await window.mxMatrixClientPeg.get().createRoom({ name: "sw-live-text", preset: "private_chat" })).room_id));
    meta.textRoomId = textRoom;
    await page.evaluate((rid) => (window.location.hash = `#/room/${rid}`), textRoom);
    await page.waitForTimeout(3000);
    const lastTok = () => { const ok = results.token.filter((x) => x.status === 200); return ok.length ? ok[ok.length - 1] : null; };
    let tok = lastTok();
    if (!tok) { out("no token refresh seen in this session yet; waiting for one"); }
    const waitStart = Date.now();
    // Wait for the first refresh in-session (token age known exactly from then).
    while (!lastTok() && Date.now() - waitStart < 400_000) await page.waitForTimeout(1000);
    tok = lastTok();
    if (!tok) {
        out("ABORT: no in-session token refresh within 400 s; no result recorded");
        await ctx.close();
        process.exit(3);
    }
    const trigger = Number(process.env.LIVE_TRIGGER_S || 303);
    // The scenario needs the stored token to be exactly `trigger` seconds old when the
    // image room opens. A refresh during the wait invalidates that: re-target on the new
    // token (bounded), and never fall through to the trigger with a fresh token, which
    // would record a clean run that tested nothing.
    for (let retargets = 0; ; retargets++) {
        const tokWall = Date.now() - (parseFloat(ts()) - parseFloat(tok.t)) * 1000;
        out(`in-session token at t=${tok.t}; waiting until age ${trigger}s, idle in text room; SWs alive=${ctx.serviceWorkers().length}`);
        const refreshesBefore = results.token.length;
        while (Date.now() - tokWall < trigger * 1000 && results.token.length === refreshesBefore) {
            await page.waitForTimeout(1000);
        }
        if (results.token.length === refreshesBefore) {
            results.liveTokenAgeS = (Date.now() - tokWall) / 1000;
            break;
        }
        if (retargets >= 2) {
            out("ABORT: token kept refreshing during the idle wait; no result recorded");
            await ctx.close();
            process.exit(3);
        }
        tok = lastTok();
        out("token refreshed during idle; re-targeting on the new token");
    }
    if (process.env.LIVE_STOP_SW === "1") {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        out("stopped SW via CDP (== browser idle termination)");
    }
    out(`token age now ${results.liveTokenAgeS.toFixed(1)}s; opening image room`);
    await page.evaluate((rid) => (window.location.hash = `#/room/${rid}`), meta.roomId);
    await page.waitForTimeout(15000);
    results.imagesFirst = await imageState();
    out(`images=${JSON.stringify(results.imagesFirst)}`);
    // Does the poison persist while the SW stays alive? Open the text room and come back.
    await page.evaluate((rid) => (window.location.hash = `#/room/${rid}`), textRoom);
    await page.waitForTimeout(2000);
    await page.evaluate((rid) => (window.location.hash = `#/room/${rid}`), meta.roomId);
    await page.waitForTimeout(8000);
    results.imagesAfterReload = await imageState();
    out(`images after room re-open=${JSON.stringify(results.imagesAfterReload)}`);
    meta.lastTokenAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
} else if (mode === "setup") {
    const wallet = makeWallet();
    await injectMockWallet(page, wallet);
    await page.goto(ELEMENT_URL, { waitUntil: "domcontentloaded" });
    await page.waitForURL((u) => u.origin === SIWX_ORIGIN, { timeout: 60_000 });
    await page.getByRole("button", { name: "Sign in with Ethereum" }).click();
    const gateBtn = page.getByRole("button", { name: "Continue" }).first();
    const skipBtn = page.getByRole("button", { name: "Skip for now" }).first();
    for (let i = 0; i < 3; i++) {
        const which = await Promise.race([
            gateBtn.waitFor({ timeout: 20_000 }).then(() => "gate").catch(() => null),
            skipBtn.waitFor({ timeout: 20_000 }).then(() => "skip").catch(() => null),
            page.waitForURL((u) => u.origin === new URL(ELEMENT_URL).origin, { timeout: 20_000 }).then(() => "element").catch(() => null),
        ]);
        if (which === "gate") await gateBtn.click();
        else if (which === "skip") await skipBtn.click();
        else break;
    }
    await page.waitForURL((u) => u.origin === new URL(ELEMENT_URL).origin, { timeout: 60_000 });
    const chat = page.locator(".mx_MatrixChat");
    const btn = (name) => page.getByRole("button", { name, disabled: false }).first();
    await chat.or(btn(/^Continue$/)).first().waitFor({ timeout: 150_000 });
    if (!(await chat.count())) {
        await btn(/^Continue$/).click();
        await btn(/^Copy$/).click({ timeout: 120_000 });
        await btn(/^Continue$/).click({ timeout: 30_000 });
        await btn(/^Done$/).click({ timeout: 60_000 });
        await chat.waitFor({ timeout: 90_000 });
    }
    out("logged in");
    const png = makePng().toString("base64");
    const info = await page.evaluate(async (b64) => {
        const cli = window.mxMatrixClientPeg.get();
        const r = await cli.createRoom({ name: "sw-versions-repro", preset: "private_chat" });
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const { content_uri } = await cli.uploadContent(new Blob([bytes], { type: "image/png" }), { type: "image/png", name: "repro.png" });
        await cli.sendMessage(r.room_id, { msgtype: "m.image", body: "repro.png", url: content_uri, info: { mimetype: "image/png", size: bytes.length, w: 64, h: 64 } });
        return { roomId: r.room_id, userId: cli.getUserId(), mxc: content_uri };
    }, png);
    meta = { ...info, arm, loginAt: Date.now() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
    await page.evaluate((rid) => (window.location.hash = `#/room/${rid}`), info.roomId);
    await page.waitForTimeout(8000);
    out(`image state after setup: ${JSON.stringify(await imageState())}`);
    out(`controlled=${await page.evaluate(() => !!navigator.serviceWorker.controller)}`);
} else {
    if (!meta.roomId) throw new Error("no meta; run setup first");
    const tokAt = meta.lastTokenAt || meta.loginAt;
    if (mode === "reopen" && Date.now() - tokAt < 310_000) {
        // Browser is closed-equivalent until now: no page has been navigated yet, SW not started.
        const wait = 310_000 - (Date.now() - tokAt);
        console.log(`waiting ${(wait / 1000).toFixed(0)}s for token expiry`);
        await new Promise((r) => setTimeout(r, wait));
    }
    const ageS = ((Date.now() - tokAt) / 1000).toFixed(0);
    out(`reopen: ${ageS}s since last token issuance; arm=${arm}`);
    await page.goto(`${ELEMENT_URL}/#/room/${meta.roomId}`, { waitUntil: "domcontentloaded" });
    if (process.env.TRACE_SYNC) {
        (async () => {
            let last = "";
            for (let i = 0; i < 100; i++) {
                const st = await page.evaluate(() => { try { const c = window.mxMatrixClientPeg?.get(); return c ? `${c.getSyncState()} initDone=${c.isInitialSyncComplete()}` : "no-client"; } catch (e) { return "err"; } }).catch(() => "nav");
                if (st !== last) { out(`SYNCSTATE ${st}`); last = st; }
                await new Promise((r) => setTimeout(r, 150));
            }
        })();
    }
    await page.locator(".mx_MatrixChat").waitFor({ timeout: 90_000 }).catch(async () => out(`no MatrixChat; page text: ${(await page.evaluate(() => document.body.innerText).catch(() => "")).replace(/\s+/g, " ").slice(0, 160)}`));
    await page.waitForTimeout(15000);
    const imgs = await imageState();
    out(`controlled=${await page.evaluate(() => !!navigator.serviceWorker.controller)} images=${JSON.stringify(imgs)}`);
    // Second look after the app has certainly refreshed its token: is the SW still poisoned?
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".mx_MatrixChat").waitFor({ timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(12000);
    const imgs2 = await imageState();
    out(`after normal reload: images=${JSON.stringify(imgs2)}`);
    results.imagesFirst = imgs;
    results.imagesAfterReload = imgs2;
    if (results.token.some((x) => x.status === 200)) meta.lastTokenAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
}

const legacy404 = results.media.filter((m) => m.kind === "LEGACY" && m.status === 404 && m.fromSW).length;
const pageMediaFail = results.media.filter((m) => !m.fromSW && m.status !== 200).length;
const authedOk = results.media.filter((m) => m.kind === "AUTHED" && m.status === 200 && !/swprobe/.test(m.p)).length;
const v401 = results.versions.filter((v) => v.status === 401 && v.fromSW).length;
const poisoned = results.swConsole.some((l) => /serverSupportMap update.*"supportsAuthedMedia":false/.test(l));
const swAnonRetry = results.swConsole.some((l) => /retrying without one/.test(l));
const swMediaRetry = results.swConsole.some((l) => /retrying media request with a refreshed access token/.test(l));
const firstImgs = results.imagesFirst || [];
const pass = !poisoned && firstImgs.length > 0 && firstImgs.every((i) => i.loaded);
const summary = { mode, label, arm, profile: path.basename(profileDir), pass, swAnonRetry, swMediaRetry, swVersions401: v401, swPoisonedLog: poisoned, legacy404, pageMediaFail, authedOk, imgsFirstLoaded: (results.imagesFirst||[]).filter(i=>i.loaded).length + "/" + (results.imagesFirst||[]).length, imgsReloadLoaded: (results.imagesAfterReload||[]).filter(i=>i.loaded).length + "/" + (results.imagesAfterReload||[]).length, tokenRefreshes: results.token.length };
out(`SUMMARY ${JSON.stringify(summary)}`);
fs.writeFileSync(path.join(profileDir, `${label}-${Date.now()}.json`), JSON.stringify({ summary, results, log }, null, 1));
await ctx.close();
