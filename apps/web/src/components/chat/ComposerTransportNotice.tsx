import type { HostId } from "@saint/shared/hostId";
import { useEffect, useState } from "react";

import { StatusDot } from "~/components/ui/status-chip";
import { useHostId } from "~/hosts/hostScope";
import { subscribeComposerTransportStatus } from "~/lib/composerTransportStatus";
import { ComposerCapsule } from "./ComposerCapsule";

/** Transport presentation stays local; it must not become a transcript activity signal. */
export function ComposerTransportNotice() {
  const hostId = useHostId();
  const [status, setStatus] = useState<{ hostId: HostId; message: string | null }>({
    hostId,
    message: null,
  });
  useEffect(
    () => subscribeComposerTransportStatus((message) => setStatus({ hostId, message }), hostId),
    [hostId],
  );

  const message = status.hostId === hostId ? status.message : null;
  if (message === null) return null;

  // Like the other capsules, mount without motion and remove immediately on recovery.
  return (
    <ComposerCapsule role="status" icon={<StatusDot aria-hidden className="bg-amber-500" />}>
      <span className="text-muted-foreground">{message}</span>
    </ComposerCapsule>
  );
}
