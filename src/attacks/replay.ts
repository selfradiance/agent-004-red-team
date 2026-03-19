// Replay attack scenarios — tests whether AgentGate rejects duplicate nonces and replayed requests

import type { AttackResult } from "../log";

export interface AttackScenario {
  id: string;
  name: string;
  category: string;
  description: string;
  expectedOutcome: string;
  execute: (client: any) => Promise<AttackResult>;
}

export const replayAttacks: AttackScenario[] = [
  {
    id: "1.1",
    name: "Exact request replay",
    category: "replay",
    description: "Replay an identical signed request with the same nonce",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "1.2",
    name: "Replay with fresh timestamp",
    category: "replay",
    description: "Replay a request with the original nonce but a new timestamp",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "1.3",
    name: "Replay after TTL expiry",
    category: "replay",
    description: "Replay a request after the nonce TTL window has passed",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
