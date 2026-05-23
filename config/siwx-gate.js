(function () {
  function hasToken() {
    return (
      localStorage.getItem("mx_access_token") ||
      localStorage.getItem("mx_has_access_token")
    );
  }

  var isCallback = new URLSearchParams(window.location.search).has("code");

  if (hasToken()) {
    // Authenticated: let Element load. Watch for SPA-internal logout
    // (Element clears tokens then navigates to #/welcome without a full
    // page reload, so the gate never re-fires without this listener).
    window.addEventListener("hashchange", function () {
      if (!hasToken()) window.location.reload();
    });
    return;
  }

  if (isCallback) {
    // Returning from OIDC with ?code=: handle the token exchange BEFORE
    // Element loads, otherwise Element's native MSC3861 OIDC flow races
    // with our callback and creates a 401 loop on /authorize.
    document.write(
      '<html><head></head><body>' +
        '<div style="display:flex;position:fixed;inset:0;align-items:center;justify-content:center;background:#0d1117;color:#fff;font-family:sans-serif">' +
        '<div style="text-align:center">' +
        '<img src="inblockio_logo_dark.png" style="width:200px;margin-bottom:20px" alt="">' +
        '<p>Completing sign-in...</p>' +
        "</div></div>" +
        '<script src="siwx-callback.js"><\/script>' +
        "</body></html>"
    );
    document.close();
    return;
  }

  // Not authenticated, no callback: redirect to OIDC login
  document.write(
    '<html><head></head><body>' +
      '<div style="display:flex;position:fixed;inset:0;align-items:center;justify-content:center;background:#0d1117;color:#fff;font-family:sans-serif">' +
      '<div style="text-align:center">' +
      '<img src="inblockio_logo_dark.png" style="width:200px;margin-bottom:20px" alt="">' +
      '<p>Connecting wallet...</p>' +
      "</div></div>" +
      '<script src="siwx-redirect.js"><\/script>' +
      "</body></html>"
  );
  document.close();
})();
