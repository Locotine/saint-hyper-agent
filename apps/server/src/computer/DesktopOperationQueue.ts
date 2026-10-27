import {
  DesktopOperationQueue as SharedDesktopOperationQueue,
  desktopOperationContext,
} from "@saint/shared/desktopOperationQueue";

import { ComputerBackendError } from "./ComputerBackend.ts";

export {
  DESKTOP_OPERATION_QUEUE_LIMIT,
  assertDesktopOperationActive,
  desktopDeliveryMode,
  desktopOperationContext,
  desktopOperationSignal,
  withDesktopDeliveryMode,
  withDesktopOperationSignal,
  withoutDesktopCancellation,
} from "@saint/shared/desktopOperationQueue";

/** A detached continuation cannot turn a completed call into fresh input authority. */
export function assertDesktopOperationAdmission(): void {
  const operation = desktopOperationContext();
  if (operation && !operation.active) {
    throw new ComputerBackendError(
      "The computer operation has ended; no new input may be dispatched.",
    );
  }
  operation?.signal?.throwIfAborted();
}

/** The Saint-bound queue: closed/full/target-switch failures stay
 * `ComputerBackendError`s so gateway `instanceof` checks keep working. */
export class DesktopOperationQueue extends SharedDesktopOperationQueue {
  constructor() {
    super(ComputerBackendError);
  }
}
