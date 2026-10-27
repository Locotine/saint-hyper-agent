import { describe, expect, it } from "vitest";

import { normalizeHttpsPublicOrigin, remoteAccessPolicyError } from "./config";

const remoteBase = {
  host: "0.0.0.0",
  authToken: "remote-secret",
  devUrl: undefined,
  publicUrl: undefined,
  allowInsecureRemote: false,
} as const;

describe("remote access policy", () => {
  it("requires authentication when an HTTPS proxy publishes a loopback bind", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: new URL("https://saint.example.test/"),
      }),
    ).toContain("without SAINT_AUTH_TOKEN");
  });

  it("rejects invalid public URLs in the shared embedded-server policy", () => {
    for (const publicUrl of [
      new URL("http://saint.example.test/"),
      new URL("https://saint.example.test/app"),
    ]) {
      expect(
        remoteAccessPolicyError({
          ...remoteBase,
          host: "127.0.0.1",
          publicUrl,
        }),
      ).toContain("must be an HTTPS root origin");
    }
  });

  it("accepts only credential-free HTTPS root origins", () => {
    expect(normalizeHttpsPublicOrigin(new URL("https://saint.example.test/"))?.origin).toBe(
      "https://saint.example.test",
    );
    for (const value of [
      "http://saint.example.test/",
      "https://user:pass@saint.example.test/",
      "https://saint.example.test/app",
      "https://saint.example.test/?query=1",
      "https://saint.example.test/#fragment",
    ]) {
      expect(normalizeHttpsPublicOrigin(new URL(value))).toBeNull();
    }
  });
});
