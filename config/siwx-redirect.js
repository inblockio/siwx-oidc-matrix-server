(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.has("loginToken")) return;

  var hasSession =
    localStorage.getItem("mx_access_token") ||
    localStorage.getItem("mx_has_access_token") ||
    localStorage.getItem("mx_user_id");
  if (hasSession) return;

  var splash = document.getElementById("siwx-splash");
  if (splash) splash.style.display = "flex";

  var ssoUrl =
    "%%MATRIX_BASE_URL%%/_matrix/client/v3/login/sso/redirect/siwx-oidc";
  var redirectUrl = encodeURIComponent(
    window.location.origin + window.location.pathname
  );
  window.location.replace(ssoUrl + "?redirectUrl=" + redirectUrl);
})();
