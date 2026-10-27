import * as NodeServices from "@effect/platform-node/NodeServices";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createDevRunnerEnv,
  findFirstAvailableOffset,
  readDevRunnerBooleanEnvironment,
  resolveDevRunnerBooleanOverrides,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  it("allows every generated runtime setting through Turbo", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf8"),
    ) as { globalEnv?: ReadonlyArray<string> };
    const globalEnv = new Set(turboConfig.globalEnv ?? []);

    for (const name of [
      "SAINT_MODE",
      "SAINT_PORT",
      "SAINT_HOME",
      "SAINT_NO_BROWSER",
      "SAINT_AUTH_TOKEN",
      "SAINT_PUBLIC_URL",
      "SAINT_ALLOW_INSECURE_REMOTE",
      "SAINT_HOST",
      "SAINT_LOG_WS_EVENTS",
      "SAINT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
      "VITE_WS_URL",
      "VITE_DEV_SERVER_URL",
    ]) {
      assert.ok(globalEnv.has(name), `${name} must be declared in turbo.json globalEnv`);
    }
  });

  describe("resolveOffset", () => {
    it("uses explicit SAINT_PORT_OFFSET when provided", () => {
      assert.deepStrictEqual(resolveOffset({ portOffset: 12, devInstance: undefined }), {
        offset: 12,
        source: "SAINT_PORT_OFFSET=12",
      });
    });

    it("hashes non-numeric instance values", () => {
      const result = resolveOffset({ portOffset: undefined, devInstance: "feature-branch" });
      assert.ok(result.offset >= 1);
      assert.ok(result.offset <= 3000);
    });

    it("throws for negative port offset", () => {
      assert.throws(
        () => resolveOffset({ portOffset: -1, devInstance: undefined }),
        /Invalid SAINT_PORT_OFFSET/,
      );
    });
  });

  describe("boolean precedence", () => {
    const absent = { positive: undefined, negative: undefined };

    it("uses environment values only when the CLI flag is absent", () => {
      assert.deepStrictEqual(
        resolveDevRunnerBooleanOverrides(
          {
            noBrowser: absent,
            autoBootstrapProjectFromCwd: absent,
            logWebSocketEvents: absent,
          },
          {
            noBrowser: true,
            autoBootstrapProjectFromCwd: false,
            logWebSocketEvents: true,
          },
        ),
        {
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
        },
      );
    });

    it("keeps explicit false values instead of treating them as absent", () => {
      assert.deepStrictEqual(
        resolveDevRunnerBooleanOverrides(
          {
            noBrowser: { positive: undefined, negative: true },
            autoBootstrapProjectFromCwd: { positive: false, negative: undefined },
            logWebSocketEvents: { positive: undefined, negative: true },
          },
          {
            noBrowser: true,
            autoBootstrapProjectFromCwd: true,
            logWebSocketEvents: true,
          },
        ),
        {
          noBrowser: false,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
        },
      );
    });

    it.effect("rejects invalid boolean environment values", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readDevRunnerBooleanEnvironment({ SAINT_LOG_WS_EVENTS: "sometimes" }),
        );

        assert.match(String(error), /Failed to read boolean development-runner configuration/);
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    const defaults: Parameters<typeof createDevRunnerEnv>[0] = {
      mode: "dev",
      baseEnv: {},
      serverOffset: 0,
      webOffset: 0,
      saintHome: undefined,
      authToken: undefined,
      noBrowser: undefined,
      autoBootstrapProjectFromCwd: undefined,
      logWebSocketEvents: undefined,
      host: undefined,
      port: undefined,
      devUrl: undefined,
    };

    it.effect("marks an inherited terminal PATH as already hydrated", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          baseEnv: { PATH: "/opt/homebrew/bin:/usr/bin" },
        });

        assert.equal(env.SAINT_PATH_HYDRATED, "1");
        assert.match(env.PATH ?? "", /\/opt\/homebrew\/bin/);
      }),
    );

    it.effect("defaults SAINT_HOME to ~/.saint when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
        });

        assert.equal(env.SAINT_HOME, resolve(homedir(), ".saint"));
        assert.equal(env.SAINT_HOST, "127.0.0.1");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:3773");
      }),
    );

    it.effect("defaults watched desktop development to ~/.saint-dev", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:desktop",
        });

        assert.equal(env.SAINT_HOME, resolve(homedir(), ".saint-dev"));
      }),
    );

    it.effect("keeps watched Canary desktop data separate from development", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:desktop",
          baseEnv: { SAINT_DESKTOP_FLAVOR: "canary" },
        });

        assert.equal(env.SAINT_HOME, resolve(homedir(), ".saint-canary"));
      }),
    );

    it.effect("normalizes bracketed IPv6 hosts for listen and client URL syntax", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          host: "[::1]",
        });

        assert.equal(env.SAINT_HOST, "::1");
        assert.equal(env.VITE_WS_URL, "ws://[::1]:3773");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          mode: "dev:server",
          saintHome: "/tmp/custom-saint",
          authToken: "secret",
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.SAINT_HOME, resolve("/tmp/custom-saint"));
        assert.equal(env.SAINT_PORT, "4222");
        assert.equal(env.SAINT_NO_BROWSER, "1");
        assert.equal(env.SAINT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.SAINT_LOG_WS_EVENTS, "1");
        assert.equal(env.SAINT_HOST, "0.0.0.0");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:4222");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          ...defaults,
          baseEnv: {
            SAINT_LOG_WS_EVENTS: "keep-me-out",
          },
        });

        assert.equal(env.SAINT_MODE, "web");
        assert.equal(env.SAINT_LOG_WS_EVENTS, undefined);
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733, 3774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("allows offsets where only non-required ports exceed max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_803,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_803);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([3773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });
});
