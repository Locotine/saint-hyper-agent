import { ServiceMap } from "effect";

import type { ComputerAvailability } from "@saint/contracts";
import type { ComputerManager } from "../ComputerManager.ts";

export interface ComputerServiceShape {
  readonly supported: boolean;
  readonly availability: ComputerAvailability;
  readonly manager: ComputerManager;
}

export class ComputerService extends ServiceMap.Service<ComputerService, ComputerServiceShape>()(
  "saint/computer/Services/ComputerService",
) {}
