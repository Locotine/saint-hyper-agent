// Local only: run the CI browser lanes with the system Chrome.
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import ciConfig from "./vitest.browser.ci.config";
export default mergeConfig(
  ciConfig,
  defineConfig({
    test: {
      browser: {
        provider: playwright({
          launchOptions: { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] },
        }),
      },
    },
  }),
);
