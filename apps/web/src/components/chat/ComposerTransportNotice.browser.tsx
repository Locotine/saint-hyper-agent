import "../../index.css";

import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { HostScope } from "../../hosts/hostScope";
import { emitWsTransportState } from "../../wsTransportEvents";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerTransportNotice } from "./ComposerTransportNotice";

const REMOTE_HOST_ID = sshHostId("a1b2c3d4");

describe("composer transport notice", () => {
  afterEach(() => {
    emitWsTransportState("open", LOCAL_HOST_ID);
    emitWsTransportState("open", REMOTE_HOST_ID);
  });

  it("renders a delayed live status from transport events and removes it on recovery", async () => {
    emitWsTransportState("open");
    const screen = await render(
      <ComposerColumnFrame>
        <ComposerTransportNotice />
        <textarea aria-label="Message" defaultValue="Keep my draft" />
      </ComposerColumnFrame>,
    );
    try {
      emitWsTransportState("connecting");
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Saint…");
      expect(screen.container.querySelector("button")).toBeNull();
      await expect
        .element(page.getByRole("textbox", { name: "Message" }))
        .toHaveValue("Keep my draft");
      emitWsTransportState("open");
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("replays a closed transport to a newly mounted composer", async () => {
    emitWsTransportState("closed");
    const screen = await render(
      <ComposerColumnFrame>
        <ComposerTransportNotice />
      </ComposerColumnFrame>,
    );
    try {
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Saint…");
    } finally {
      await screen.unmount();
    }
  });

  it("tracks the active HostScope instead of showing local outages on a healthy remote chat", async () => {
    emitWsTransportState("closed", LOCAL_HOST_ID);
    emitWsTransportState("open", REMOTE_HOST_ID);
    const screen = await render(
      <HostScope hostId={LOCAL_HOST_ID}>
        <ComposerColumnFrame>
          <ComposerTransportNotice />
        </ComposerColumnFrame>
      </HostScope>,
    );
    try {
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Saint…");

      await screen.rerender(
        <HostScope hostId={REMOTE_HOST_ID}>
          <ComposerColumnFrame>
            <ComposerTransportNotice />
          </ComposerColumnFrame>
        </HostScope>,
      );
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();

      emitWsTransportState("closed", REMOTE_HOST_ID);
      await expect
        .element(page.getByRole("status"), { timeout: 4000 })
        .toHaveTextContent("Reconnecting to Saint…");

      emitWsTransportState("open", REMOTE_HOST_ID);
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
