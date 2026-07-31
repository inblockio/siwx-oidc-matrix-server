/*
 * Service-worker media-auth boot shim (loaded from <head>, before any app
 * bundle). Independent guards for the 2026-07-31 media-download RCA
 * (docs/superpowers/plans/2026-07-31-ew-sw-boot-shim.md; guard E's
 * differential-probe spec is
 * docs/superpowers/plans/2026-07-31-sw-hardening-handover.md):
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
 *
 * (E) SW liveness canary. The 2026-07-31 incident's root cause: a wedged
 *     service worker whose respondWith() never settles hangs every media
 *     fetch forever, with no error and no network entry — silent for the
 *     rest of the browser's lifetime. When the page IS controlled (the (B)
 *     case above only covers the uncontrolled page), run a DIFFERENTIAL
 *     probe: race a SW-intercepted fetch to the HOMESERVER origin (this
 *     exercises the SW's real IndexedDB-token-lookup + authed-fetch rewrite
 *     path — the actual wedge-prone code) against an ~8000 ms timer, while
 *     TWO control fetches the SW does NOT intercept settle independently
 *     through the normal network: one on the element origin (proves the
 *     origin sw.js must be re-fetched from after a heal is reachable) and
 *     one on the homeserver origin (proves the probe's own network path is
 *     alive, so a slow-but-up Synapse — overload, a stack deploy's restart
 *     window — can't read as a wedge). A single timeout alone is not a safe
 *     trigger: a stalled network (mobile, VPN reconnect, laptop resume)
 *     reads identically to a wedged SW, and unregistering on a bad network
 *     can recreate the original incident (no SW -> tokenless media 404s).
 *     Heal ONLY when the probe times out AND both controls have settled —
 *     both network paths provably alive, SW provably hung. If anything else
 *     hangs, do nothing. On a confirmed wedge: unregister it and reload once
 *     (sessionStorage sentinel, same one-shot pattern as (B)). This
 *     automates the manual DevTools "Unregister + reload" fix confirmed to
 *     clear a wedge instantly. E heals a wedge that exists when the page
 *     loads (or, for a background-opened tab, when it is first shown — see
 *     the visibilitychange handling below); it does not re-probe mid-life.
 *     A wedge appearing later heals on next navigation, where the
 *     per-build sw.js stamp (Dockerfile.element) also evicts it after any
 *     deploy.
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

    // (E) SW liveness canary
    window.addEventListener("load", function () {
        function armSwCanary() {
            setTimeout(function () {
                try {
                    if (!navigator.serviceWorker.controller) return; // uncontrolled page: (B) handles this case
                    if (sessionStorage.getItem("io.inblock.swCanaryReloaded")) return; // already healed this tab

                    // Probe the HOMESERVER origin, not element's own origin: the SW's
                    // fetch handler matches by pathname regardless of origin, so this
                    // exercises its real rewrite path (IndexedDB token lookup + authed
                    // /_matrix/client/v1/media fetch — the actual wedge-prone code) end
                    // to end. A same-origin probe instead 404s at element-web's own
                    // nginx on every load (an nginx error-log line) and trips the SW's
                    // rewrite-error console.error on every load, without ever reaching
                    // the SW's real network path — exactly the noise chased during the
                    // incident. Missing localStorage means a logged-out page: nothing
                    // to protect, and returning early avoids garbage requests.
                    // Note: an mx_hs_url carrying a path prefix (or a
                    // malformed value) builds a probe pathname the SW does
                    // not intercept, so the probe settles fast through the
                    // network and the canary silently reports "alive" —
                    // fail-open by design (upstream's SW would not intercept
                    // that deployment's real media URLs either, so there is
                    // no wedge class to detect there).
                    var hs = localStorage.getItem("mx_hs_url");
                    var uid = localStorage.getItem("mx_user_id");
                    if (!hs || !uid) return;

                    // Local server name only (never a foreign/made-up one): a fake
                    // server name would trigger a federation lookup that could itself
                    // outlast the timer, and would defeat the "attributable local 404"
                    // property below.
                    var serverName = uid.split(":").slice(1).join(":");
                    if (!serverName) return;

                    // "swprobe" is a deliberately recognizable, nonexistent media id: the
                    // resulting Synapse 404 shows up in logs as attributable to this
                    // canary on the local server name, not confused with a real user's
                    // failed media fetch, and never a federation lookup.
                    var probeUrl =
                        hs.replace(/\/+$/, "") +
                        "/_matrix/media/v3/thumbnail/" +
                        serverName +
                        "/swprobe?width=1&height=1";

                    var probe = fetch(probeUrl, { cache: "no-store" }).then(
                        function () {
                            return "settled"; // fulfilled (incl. a 404): SW handled the request
                        },
                        function () {
                            return "settled"; // rejected (e.g. offline): SW still handled it
                        },
                    );

                    // Differential controls: paths the SW's fetch handler does NOT
                    // respondWith (it only matches /_matrix/media/v3/download|thumbnail
                    // pathnames), so they always settle through the normal network even
                    // under a wedged SW. Two of them, because the probe spans two
                    // origins: the element-origin control proves the origin sw.js must
                    // be re-fetched from after a heal is reachable (unregistering on a
                    // bad network can recreate the original incident of no SW ->
                    // tokenless media 404s), and the homeserver-origin control proves
                    // the probe's own network path is alive (a slow-but-up Synapse
                    // must not read as a wedge). The ?swcanary=1 marker keeps these
                    // distinguishable from the app's own fetches in logs; each is one
                    // extra request per page load per tab.
                    var elementControlSettled = false;
                    fetch("/version?swcanary=1", { cache: "no-store" }).then(
                        function () {
                            elementControlSettled = true;
                        },
                        function () {
                            elementControlSettled = true;
                        },
                    );
                    var hsControlSettled = false;
                    fetch(hs.replace(/\/+$/, "") + "/_matrix/client/versions?swcanary=1", {
                        cache: "no-store",
                    }).then(
                        function () {
                            hsControlSettled = true;
                        },
                        function () {
                            hsControlSettled = true;
                        },
                    );

                    // No AbortController: aborting the fetch would settle its own promise
                    // and mask a genuinely wedged respondWith() as "alive". A plain timer
                    // promise racing the real fetch can't be fooled that way.
                    var timer = new Promise(function (resolve) {
                        setTimeout(function () {
                            resolve("timeout");
                        }, 8000);
                    });

                    Promise.race([probe, timer]).then(function (outcome) {
                        if (outcome !== "timeout") return; // fetch settled first: SW is alive, nothing to do
                        // Either network path stalled: don't unregister on a bad
                        // network — every ambiguous case fails toward not healing.
                        if (!elementControlSettled || !hsControlSettled) return;

                        // The one-shot guarantee must never depend on an unverified
                        // write: if the sentinel can't be provably persisted (private
                        // mode, quota), skip the heal entirely rather than risk a
                        // reload loop.
                        try {
                            sessionStorage.setItem("io.inblock.swCanaryReloaded", "1");
                            if (sessionStorage.getItem("io.inblock.swCanaryReloaded") !== "1") return;
                        } catch (e) {
                            return;
                        }

                        console.warn("sw-boot: SW liveness probe hung; unregistering wedged service worker");
                        navigator.serviceWorker
                            .getRegistration()
                            .then(function (reg) {
                                return reg ? reg.unregister() : null;
                            })
                            .then(function () {
                                location.reload();
                            })
                            .catch(function () {
                                location.reload(); // reload regardless: the sentinel guarantees one-shot
                            });
                    });
                } catch (e) {
                    // A guard must never break the app.
                }
            }, 3000);
        }

        // Browsers throttle background-tab timers; don't arm the delay on a
        // hidden tab. Wait for the first visibilitychange to visible instead
        // (removing the listener once it fires). The canary still runs at
        // most once per page load either way.
        if (document.hidden) {
            document.addEventListener("visibilitychange", function onSwCanaryVisible() {
                if (document.hidden) return;
                document.removeEventListener("visibilitychange", onSwCanaryVisible);
                armSwCanary();
            });
        } else {
            armSwCanary();
        }
    });
})();
