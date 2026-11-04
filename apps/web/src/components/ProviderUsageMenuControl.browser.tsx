import "../index.css";

import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { createHostStore, HostStoreProvider } from "~/store";
import { useAccountRateLimitThreads } from "./ProviderUsageMenuControl";

function storeWithRateLimit(
  hostId: typeof LOCAL_HOST_ID | ReturnType<typeof sshHostId>,
  tag: string,
) {
  const store = createHostStore(hostId);
  const threadId = `thread-${tag}`;
  store.setState({
    threadIds: [threadId],
    activityIdsByThreadId: { [threadId]: [`activity-${tag}`] },
    activityByThreadId: {
      [threadId]: {
        [`activity-${tag}`]: { id: `activity-${tag}`, kind: "account.rate-limits.updated" },
      },
    },
  } as never);
  return store;
}

const renders = { rail: 0, remote: 0 };

function Probe({ name }: { name: keyof typeof renders }) {
  renders[name] += 1;
  const threads = useAccountRateLimitThreads();
  const [, setTick] = useState(0);
  void setTick;
  return <span data-probe={name}>{threads.length}</span>;
}

describe("useAccountRateLimitThreads", () => {
  it("settles when this computer's store and a host's store both hold rate-limit activity", async () => {
    renders.rail = 0;
    renders.remote = 0;
    const local = storeWithRateLimit(LOCAL_HOST_ID, "local");
    const remote = storeWithRateLimit(sshHostId("a1b2c3d4"), "remote");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" ").slice(0, 300));
    try {
      const screen = await render(
        <>
          <HostStoreProvider value={local}>
            <Probe name="rail" />
          </HostStoreProvider>
          <HostStoreProvider value={remote}>
            <Probe name="remote" />
          </HostStoreProvider>
        </>,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(errors.filter((line) => /Maximum update depth|getSnapshot/u.test(line))).toEqual([]);
      expect(renders.rail).toBeLessThan(10);
      expect(renders.remote).toBeLessThan(10);
      await screen.unmount();
    } finally {
      console.error = originalError;
    }
  });
});
