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
})();
