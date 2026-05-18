(function () {
  var params = new URLSearchParams(window.location.search);
  if (!params.has("code")) return;

  var code = params.get("code");
  var state = params.get("state");
  var storedState = sessionStorage.getItem("siwx_state");
  var codeVerifier = sessionStorage.getItem("siwx_code_verifier");
  var hsUrl = sessionStorage.getItem("siwx_hs_url");
  var clientId = sessionStorage.getItem("siwx_client_id");

  if (!codeVerifier || !clientId || state !== storedState) {
    console.error("OIDC callback: state mismatch or missing session data");
    return;
  }

  var OIDC_BASE = "%%SIWEOIDC_BASE_URL%%";

  // Show splash while exchanging token
  var splash = document.getElementById("siwx-splash");
  if (splash) splash.style.display = "flex";

  async function exchangeCode() {
    // Exchange authorization code for tokens
    var tokenResp = await fetch(OIDC_BASE + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: window.location.origin + "/",
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!tokenResp.ok) {
      console.error(
        "Token exchange failed:",
        tokenResp.status,
        await tokenResp.text()
      );
      return;
    }

    var tokenData = await tokenResp.json();
    var accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("Token exchange returned no access_token:", tokenData);
      return;
    }

    // Retrieve user_id and device_id from the homeserver
    var whoamiResp = await fetch(
      hsUrl + "/_matrix/client/v3/account/whoami",
      { headers: { Authorization: "Bearer " + accessToken } }
    );

    if (!whoamiResp.ok) {
      console.error(
        "whoami request failed:",
        whoamiResp.status,
        await whoamiResp.text()
      );
      return;
    }

    var whoami = await whoamiResp.json();

    // Store session state for Element Web
    localStorage.setItem("mx_access_token", accessToken);
    localStorage.setItem("mx_user_id", whoami.user_id);
    localStorage.setItem("mx_device_id", whoami.device_id || "");
    localStorage.setItem("mx_hs_url", hsUrl);
    localStorage.setItem("mx_is_url", "");
    localStorage.setItem("mx_has_access_token", "true");

    // Clean up OIDC session data
    sessionStorage.removeItem("siwx_code_verifier");
    sessionStorage.removeItem("siwx_state");
    sessionStorage.removeItem("siwx_client_id");
    sessionStorage.removeItem("siwx_hs_url");

    // Reload without query params to let Element pick up the session
    window.location.replace(window.location.origin + window.location.pathname);
  }

  exchangeCode().catch(function (e) {
    console.error("OIDC callback failed:", e);
  });
})();
