// Rate limit attack scenarios — tests whether AgentGate throttles excessive requests

import type { AttackResult } from "../log";
import type { AttackScenario } from "./replay";

export const rateLimitAttacks: AttackScenario[] = [
  {
    id: "6.1",
    name: "Burst request flood",
    category: "rate-limit",
    description: "Send a rapid burst of requests to test rate limiting",
    expectedOutcome: "throttled",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
