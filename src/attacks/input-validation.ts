// Input validation attack scenarios — tests whether AgentGate rejects malformed or extreme inputs

import type { AttackResult } from "../log";
import type { AttackScenario } from "./replay";

export const inputValidationAttacks: AttackScenario[] = [
  {
    id: "5.1",
    name: "Negative bond amount",
    category: "input-validation",
    description: "Attempt to lock a bond with a negative cent amount",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "5.2",
    name: "Oversized payload",
    category: "input-validation",
    description: "Send an action with an extremely large payload string",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "5.3",
    name: "Invalid action type characters",
    category: "input-validation",
    description: "Send an action with special characters in the actionType field",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
