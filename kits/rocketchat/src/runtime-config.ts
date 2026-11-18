// Rocket.Chat reads its root URL from Meteor's runtime config global; the kit serves from the page origin.
const w = window as unknown as { __meteor_runtime_config__?: Record<string, string> };
w.__meteor_runtime_config__ = { ROOT_URL: `${window.location.origin}/`, ROOT_URL_PATH_PREFIX: '', ...w.__meteor_runtime_config__ };
