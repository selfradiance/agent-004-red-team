// Authorization attack scenarios — tests whether AgentGate enforces identity-scoped access

import type { AttackResult } from "../log";
import type { AttackScenario } from "./replay";

export const authorizationAttacks: AttackScenario[] = [
  {
    id: "4.1",
    name: "Resolve another identity's action",
    category: "authorization",
    description: "Attempt to resolve an action belonging to a different identity",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "4.2",
    name: "Execute on another identity's bond",
    category: "authorization",
    description: "Attempt to execute an action against a bond owned by a different identity",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
