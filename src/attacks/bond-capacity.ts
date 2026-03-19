// Bond capacity attack scenarios — tests whether AgentGate enforces bond limits correctly

import type { AttackResult } from "../log";
import type { AttackScenario } from "./replay";

export const bondCapacityAttacks: AttackScenario[] = [
  {
    id: "2.1",
    name: "Exceed bond capacity",
    category: "bond-capacity",
    description: "Attempt to execute an action with exposure exceeding bond capacity",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "2.2",
    name: "Double-spend bond",
    category: "bond-capacity",
    description: "Attempt to execute two actions against the same bond exceeding total capacity",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "2.3",
    name: "Zero-cent bond",
    category: "bond-capacity",
    description: "Attempt to lock a bond with zero cents",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
