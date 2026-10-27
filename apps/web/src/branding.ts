export const APP_BASE_NAME = "Saint";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "saint-canary:";
const isBetaDesktop = typeof window !== "undefined" && window.location?.protocol === "saint-beta:";
export const APP_DISPLAY_NAME = isCanaryDesktop
  ? "Saint Canary"
  : isBetaDesktop
    ? "Saint Beta"
    : import.meta.env.DEV
      ? `${APP_BASE_NAME} (Dev)`
      : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
