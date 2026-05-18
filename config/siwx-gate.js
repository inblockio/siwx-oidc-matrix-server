(function () {
  var hasToken =
    localStorage.getItem("mx_access_token") ||
    localStorage.getItem("mx_has_access_token");
  var isCallback = new URLSearchParams(window.location.search).has("code");

  if (!hasToken && !isCallback) {
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
  }
})();
