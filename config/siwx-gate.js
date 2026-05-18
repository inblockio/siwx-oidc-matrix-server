(function () {
  var LOGIN_PAGE = "/siwx-login.html";

  function hasToken() {
    return (
      localStorage.getItem("mx_access_token") ||
      localStorage.getItem("mx_has_access_token")
    );
  }

  if (!hasToken()) {
    window.location.replace(
      LOGIN_PAGE + window.location.search + window.location.hash
    );
    return;
  }

  // --- User is logged in: override Element's "Remove this device" ---

  function performLogout() {
    var token = localStorage.getItem("mx_access_token");
    var hsUrl = localStorage.getItem("mx_hs_url") || "";

    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.startsWith("mx_")) keys.push(k);
    }
    keys.forEach(function (k) {
      localStorage.removeItem(k);
    });
    sessionStorage.clear();

    if (token && hsUrl) {
      fetch(hsUrl + "/_matrix/client/v3/logout", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: "{}",
      }).finally(function () {
        window.location.replace(LOGIN_PAGE);
      });
    } else {
      window.location.replace(LOGIN_PAGE);
    }
  }

  // Resilient mechanism: intercept fetch() calls that DELETE the current device.
  // Element fires DELETE /_matrix/client/v3/devices/{id} when the user clicks
  // "Remove this device". We return a fake 200 (preventing the interactive auth
  // dialog) and run our logout flow instead, which revokes the token but keeps
  // the device intact for cross-signing state.
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init && init.method) || (input && input.method) || "GET";

    if (
      method.toUpperCase() === "DELETE" &&
      url.includes("/_matrix/client/v3/devices/")
    ) {
      var deviceId = localStorage.getItem("mx_device_id");
      if (deviceId && url.endsWith("/" + encodeURIComponent(deviceId))) {
        performLogout();
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
    }
    return origFetch.apply(this, arguments);
  };

  // Cosmetic: rename "Remove this device" buttons to "Sign out".
  function relabelButtons() {
    document.querySelectorAll("button, [role='button']").forEach(function (el) {
      if (el.textContent.trim() === "Remove this device") {
        el.textContent = "Sign out";
      }
    });
  }

  function setupDomOverrides() {
    if (!document.body) return;
    var timer;
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(relabelButtons, 100);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    setupDomOverrides();
  } else {
    document.addEventListener("DOMContentLoaded", setupDomOverrides);
  }
})();
