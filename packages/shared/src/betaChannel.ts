// FILE: betaChannel.ts
// Purpose: Shared constants and types for the Stable ↔ Saint Beta handoff flow.
// Layer: Shared contracts (consumed by desktop main, server, and web settings UI)

import { Schema } from "effect";

/** Beta's data home; stable writes the import marker here, the beta server consumes it. */
export const SAINT_BETA_HOME_DIR_NAME = ".saint-beta";
export const BETA_IMPORT_REQUEST_FILE_NAME = "import-requested.json";
export const BETA_IMPORT_RESULT_FILE_NAME = "import-result.json";

/**
 * electron-builder NSIS `guid` for beta builds. The uninstall registry key is
 * the raw GUID (no braces — see app-builder-lib NsisTarget / multiUser.nsh).
 */
export const SAINT_BETA_WINDOWS_INSTALLER_GUID = "e5cb6c41-44ef-4989-a949-8b42c1d9b788";

/** Public release listing for every Saint build this fork publishes. */
export const SAINT_RELEASES_URL = "https://github.com/Locotine/saint-hyper-agent/releases";

/** Download page handed to the user when beta is not installed. */
export const SAINT_BETA_RELEASES_URL = SAINT_RELEASES_URL;

/** Download page offered from beta when stable Saint is not installed. */
export const SAINT_STABLE_RELEASES_URL = SAINT_RELEASES_URL;

/** electron-builder NSIS `guid` for stable (production) builds. */
export const SAINT_STABLE_WINDOWS_INSTALLER_GUID = "03736dce-37a8-431c-9e4d-359a0a86ee78";

/**
 * Environment overrides for the beta install flow. `SAINT_BETA_HOME` moves the
 * beta data home everywhere it is resolved (stable's import marker, beta's own
 * base dir, the running-probe). `SAINT_BETA_FEED_URL` points at a base URL
 * serving `beta-mac.yml` plus the files it lists; `SAINT_BETA_INSTALL_DIR` and
 * `SAINT_BETA_USER_DATA` relocate the app bundle and its Electron profile.
 */
export const SAINT_BETA_HOME_ENV = "SAINT_BETA_HOME";
export const SAINT_BETA_FEED_URL_ENV = "SAINT_BETA_FEED_URL";
export const SAINT_BETA_INSTALL_DIR_ENV = "SAINT_BETA_INSTALL_DIR";
export const SAINT_BETA_USER_DATA_ENV = "SAINT_BETA_USER_DATA";

/**
 * Set by stable when it launches beta, so "Switch back to Saint" reopens that
 * exact stable app with its own data home instead of guessing install paths.
 */
export const SAINT_STABLE_EXECUTABLE_ENV = "SAINT_STABLE_EXECUTABLE";
export const SAINT_STABLE_HOME_ENV = "SAINT_STABLE_HOME";

/** Tag shape of a beta release: `v<version>-beta.<N>`. */
export const BETA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+-beta\.\d+$/;

export const BetaImportRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestedAt: Schema.String,
  /** Absolute path of the requesting install's Saint home (e.g. `~/.saint`). */
  sourceHomeDir: Schema.String,
});
export type BetaImportRequest = typeof BetaImportRequest.Type;

export const BetaImportResult = Schema.Struct({
  version: Schema.Literal(1),
  completedAt: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type BetaImportResult = typeof BetaImportResult.Type;

export const decodeBetaImportRequest = Schema.decodeUnknownSync(BetaImportRequest);
export const decodeBetaImportResult = Schema.decodeUnknownSync(BetaImportResult);
