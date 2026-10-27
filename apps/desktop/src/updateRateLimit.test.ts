import { describe, expect, it } from "vitest";

import {
  describeUpdateRateLimit,
  parseUpdateRateLimit,
  UPDATE_RATE_LIMIT_DEFAULT_DELAY_MS,
} from "./updateRateLimit";

const NOW = Date.UTC(2026, 9, 27, 10, 51, 46);

// Shape of electron-updater's GitLab provider error, headers trimmed.
const GITLAB_429 =
  'Unable to find latest release on GitLab (https://gitlab.com/api/v4/projects/x%2Fy/releases/permalink/latest): HttpError: 429 "method: GET url: https://gitlab.com/api/v4/projects/x%2Fy/releases/permalink/latest\\n\\n Data:\\n Rate limit exceeded" Headers: { "cache-control": "no-store", "ratelimit-name": "unauthenticated_traffic_per_ip", "ratelimit-reset": "1793098800", "retry-after": "494", "server": "cloudflare" } at createHttpError (httpExecutor.js:21:12)';

describe("parseUpdateRateLimit", () => {
  it("prefers Retry-After", () => {
    expect(parseUpdateRateLimit(GITLAB_429, NOW)).toEqual({ retryAtMs: NOW + 494_000 });
  });

  it("falls back to the RateLimit-Reset epoch", () => {
    const message = GITLAB_429.replace('"retry-after": "494", ', "");
    expect(parseUpdateRateLimit(message, NOW)).toEqual({ retryAtMs: 1_793_098_800_000 });
  });

  it("uses a default delay without hints and clamps extreme ones", () => {
    expect(parseUpdateRateLimit("HttpError: 429 Too Many Requests", NOW)).toEqual({
      retryAtMs: NOW + UPDATE_RATE_LIMIT_DEFAULT_DELAY_MS,
    });
    expect(parseUpdateRateLimit('HttpError: 429 "retry-after": "1"', NOW)).toEqual({
      retryAtMs: NOW + 60_000,
    });
    expect(parseUpdateRateLimit('HttpError: 429 "retry-after": "99999"', NOW)).toEqual({
      retryAtMs: NOW + 2 * 60 * 60 * 1000,
    });
  });

  it("ignores other failures", () => {
    expect(parseUpdateRateLimit("HttpError: 404 Not Found", NOW)).toBeNull();
    expect(parseUpdateRateLimit("net::ERR_INTERNET_DISCONNECTED", NOW)).toBeNull();
  });
});

describe("describeUpdateRateLimit", () => {
  it("names the retry time", () => {
    expect(describeUpdateRateLimit({ retryAtMs: NOW }, () => "18:00")).toBe(
      "The update server is limiting requests from this network. Saint will check again at 18:00.",
    );
  });
});
