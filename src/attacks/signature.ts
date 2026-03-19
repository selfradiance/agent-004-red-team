// Signature attack scenarios — tests whether AgentGate rejects tampered or invalid signatures

import type { AttackResult } from "../log";
import type { AttackScenario } from "./replay";

export const signatureAttacks: AttackScenario[] = [
  {
    id: "3.1",
    name: "Tampered body after signing",
    category: "signature",
    description: "Sign a request then modify the body before sending",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "3.2",
    name: "Wrong private key",
    category: "signature",
    description: "Sign a request with a different keypair than the registered identity",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
  {
    id: "3.3",
    name: "Missing signature header",
    category: "signature",
    description: "Send a request with no x-agentgate-signature header",
    expectedOutcome: "rejected",
    execute: async (_client) => { throw new Error("not implemented"); },
  },
];
