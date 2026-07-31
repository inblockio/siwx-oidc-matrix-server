/*
 * Service-worker media-auth boot shim (loaded from <head>, before any app
 * bundle). Two independent guards for the 2026-07-31 media-download RCA
 * (docs/superpowers/plans/2026-07-31-ew-sw-boot-shim.md):
 *
 * (A) Early "userinfo" responder. Element Web's sw.js asks the page for
 *     {userId, deviceId, homeserver} via postMessage on EVERY media request,
 *     with a 1000 ms timeout, and on ANY failure refetches the legacy media
 *     URL without auth — which Synapse (authenticated media) 404s. The
 *     built-in responder (WebPlatform.onServiceWorkerPostMessage) answers
 *     homeserver = MatrixClientPeg.get()?.getHomeserverUrl(), which is
 *     undefined until the client has started, so during the boot window the
 *     SW throws on new URL(undefined) and every early media fetch dies
 *     tokenless. This listener registers before the app bundles, answers from
 *     localStorage (mx_user_id / mx_device_id / mx_hs_url, all written by
 *     Lifecycle.persistCredentials), and wins the race: the SW resolves on
 *     the FIRST reply carrying its responseKey. Post-boot both replies are
 *     identical, so the app's own responder stays a harmless second answer.
 *     Logged-out pages reply with nulls exactly like the built-in responder.
 *
 * (B) One-shot uncontrolled-page guard. A hard-reloaded (shift-reload) page
 *     stays UNcontrolled by the service worker for its whole lifetime — every
 *     media fetch bypasses the SW and 404s tokenless — and only a normal
 *     navigation re-attaches the controller. If an ACTIVE registration exists
 *     but this page is uncontrolled, trigger one normal reload; a
 *     sessionStorage sentinel makes it strictly one-shot per tab.
 */
(function () {
    "use strict";

    // (C) i18n manifest cache repair. The unhashed i18n/languages.json was
    // historically served without Cache-Control, so browsers hold heuristically
    // "fresh" stale copies that name deleted hashed files (-> 404 -> raw i18n
    // keys UI-wide) and that survive normal reloads indefinitely — the server's
    // new no-cache header can't reach a browser that never revalidates.
    // cache:"reload" fetches unconditionally AND replaces the HTTP cache entry
    // with the fresh response, permanently healing the profile. This script
    // runs at <head> parse time, long before the app's own manifest fetch, so
    // the app then reads the repaired entry in the same load.
    try {
        fetch("i18n/languages.json", { cache: "reload" }).catch(function () {});
        // Same repair for the download-iframe document (FileDownloader uses
        // iframe.src = "usercontent/"): it is unhashed, names a hashed
        // bundles/<hash>/usercontent.js, and is fetched at CLICK time from
        // the HTTP cache — so a stale copy from a previous deploy 404s and
        // kills the download button, surviving app reloads indefinitely.
        fetch("usercontent/", { cache: "reload" }).catch(function () {});
    } catch (e) {
        // Old fetch implementations: the no-cache header remains the floor.
    }

    // (D) Suppress native drag-start on anchors/images. Element renders file
    // download controls as real <a href> elements (shared-components
    // FileBodyView) and images are draggable by default, so a human click
    // with a few pixels of pointer drift starts an HTML5 drag instead: the
    // cursor flashes the no-drop deny symbol and the browser CANCELS the
    // click — downloads silently do nothing, with zero network/console
    // evidence. Synthetic (automation) clicks have zero drift, which is why
    // e2e never caught it; headless Chromium cannot even synthesize native
    // drags. Room-list reordering uses pointer events, not HTML5 drag, so it
    // is unaffected; the only loss is dragging images/links out of the app.
    document.addEventListener(
        "dragstart",
        function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            if (t.closest("a[href], img")) e.preventDefault();
        },
        true,
    );

    if (!("serviceWorker" in navigator)) return;

    // (A) early userinfo responder
    navigator.serviceWorker.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.type !== "userinfo" || !data.responseKey || !event.source) return;
        try {
            event.source.postMessage({
                responseKey: data.responseKey,
                userId: localStorage.getItem("mx_user_id"),
                deviceId: localStorage.getItem("mx_device_id"),
                homeserver: localStorage.getItem("mx_hs_url") || undefined,
            });
        } catch (e) {
            // Fall through silently: the app's own responder still answers.
        }
    });

    // (B) one-shot uncontrolled-page guard
    if (window !== window.top) return; // never auto-reload embedded contexts
    window.addEventListener("load", function () {
        setTimeout(function () {
            try {
                if (navigator.serviceWorker.controller) return; // controlled: healthy
                if (sessionStorage.getItem("io.inblock.swGuardReloaded")) return;
                navigator.serviceWorker.getRegistration().then(function (reg) {
                    // No/inactive registration: first visit or SW disabled —
                    // nothing to heal, and clients.claim() covers fresh installs.
                    if (!reg || !reg.active) return;
                    if (navigator.serviceWorker.controller) return; // claimed meanwhile
                    sessionStorage.setItem("io.inblock.swGuardReloaded", "1");
                    location.reload();
                });
            } catch (e) {
                // A guard must never break the app.
            }
        }, 3000);
    });
})();
