import { describe, expect, it, vi } from "vitest";

import { remoteServerForwarder } from "./remoteServerForward";

describe("remoteServerForwarder", () => {
  it("is null without a forwarding bridge and rejects without a host", async () => {
    expect(remoteServerForwarder("devbox", undefined)).toBeNull();
    const forwardPort = vi.fn(async () => "http://127.0.0.1:1/");
    await expect(
      remoteServerForwarder(null, forwardPort)?.("http://localhost:5173"),
    ).rejects.toThrow();
    expect(forwardPort).not.toHaveBeenCalled();
  });

  it("forwards the listed port and opens the same page on the local port", async () => {
    const forwardPort = vi.fn(async () => "http://127.0.0.1:41001/");
    const open = remoteServerForwarder("devbox", forwardPort);
    await expect(open?.("http://localhost:5173")).resolves.toBe("http://127.0.0.1:41001/");
    await expect(open?.("https://[::1]:8443/app?x=1")).resolves.toBe(
      "https://127.0.0.1:41001/app?x=1",
    );
    expect(forwardPort).toHaveBeenNthCalledWith(1, { host: "devbox", remotePort: 5173 });
    expect(forwardPort).toHaveBeenNthCalledWith(2, { host: "devbox", remotePort: 8443 });
  });
});
