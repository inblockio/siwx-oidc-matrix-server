// Stands in for Rocket.Chat's `hooks/useIsEnterprise` at the sidebar and header sites of custom categories only (patch reason
// class "ungate category", webpack.config.js names the sites): the feature is Element's room-list sections, free, so the
// licence lookup (`/v1/licenses.info`, never answered) is not asked there. Every other importer keeps the original hook.
export const useIsEnterprise = () => ({ data: { isEnterprise: true } });
