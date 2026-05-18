(function () {
  // Skip if already authenticated
  if (
    localStorage.getItem("mx_access_token") ||
    localStorage.getItem("mx_has_access_token")
  )
    return;

  // Skip if this is a callback with an authorization code
  var params = new URLSearchParams(window.location.search);
  if (params.has("code")) return;

  // Skip if we have a loginToken (legacy fallback)
  if (params.has("loginToken")) return;

  // Show splash screen while redirecting
  var splash = document.getElementById("siwx-splash");
  if (splash) splash.style.display = "flex";

  var HS_URL = "%%MATRIX_BASE_URL%%";
  var OIDC_BASE = "%%SIWEOIDC_BASE_URL%%";

  function generateCodeVerifier() {
    var array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode.apply(null, array))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  async function sha256(plain) {
    var encoder = new TextEncoder();
    var data = encoder.encode(plain);
    var hash = await crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  async function startOidc() {
    var codeVerifier = generateCodeVerifier();
    var codeChallenge = await sha256(codeVerifier);
    var state = generateCodeVerifier();

    // Persist PKCE and state for the callback handler
    sessionStorage.setItem("siwx_code_verifier", codeVerifier);
    sessionStorage.setItem("siwx_state", state);
    sessionStorage.setItem("siwx_hs_url", HS_URL);

    // Dynamic client registration (cache client_id in sessionStorage)
    var clientId = sessionStorage.getItem("siwx_client_id");
    if (!clientId) {
      var regResp = await fetch(OIDC_BASE + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Element Web",
          redirect_uris: [window.location.origin + "/"],
          token_endpoint_auth_method: "none",
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
        }),
      });
      if (!regResp.ok) {
        console.error(
          "OIDC client registration failed:",
          regResp.status,
          await regResp.text()
        );
        return;
      }
      var regData = await regResp.json();
      clientId = regData.client_id;
      sessionStorage.setItem("siwx_client_id", clientId);
    }

    // Build authorization URL and redirect
    var authUrl =
      OIDC_BASE +
      "/authorize?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: window.location.origin + "/",
        response_type: "code",
        scope: "openid profile",
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();

    window.location.replace(authUrl);
  }

  startOidc().catch(function (e) {
    console.error("OIDC redirect failed:", e);
  });
})();
