// Input validation attack scenarios — tests whether AgentGate rejects malformed or extreme inputs

import { randomUUID } from "node:crypto";
import type { AttackResult } from "../log";
import { signRequest } from "../agentgate-client";
import type { AttackScenario, AttackClient, AttackParams } from "./replay";

const CATEGORY = "Input Validation";

// ---------------------------------------------------------------------------
// Helper — send a properly signed POST request to AgentGate
// ---------------------------------------------------------------------------

async function signedPost(
  client: AttackClient,
  apiPath: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const nonce = randomUUID();
  const timestamp = Date.now().toString();
  const signature = signRequest(client.keys.publicKey, client.keys.privateKey, nonce, "POST", apiPath, timestamp, body);

  const response = await fetch(new URL(apiPath, client.agentGateUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nonce": nonce,
      "x-agentgate-key": client.apiKey,
      "x-agentgate-timestamp": timestamp,
      "x-agentgate-signature": signature,
    },
    body: JSON.stringify(body),
  });

  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    data = { error: "UNPARSEABLE_RESPONSE" };
  }

  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// Attack 5.1: Oversized payload
// ---------------------------------------------------------------------------

async function attack5_1(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const payloadBytes = (typeof params?.payload_bytes === "number" ? params.payload_bytes : 5000);

  // Lock a bond first
  const bondResult = await signedPost(client, "/v1/bonds/lock", {
    identityId: client.identityId,
    amountCents: 100,
    currency: "USD",
    ttlSeconds: 300,
    reason: "input-validation-test-5.1",
  });

  if (bondResult.status >= 300) {
    return {
      scenarioId: "5.1",
      scenarioName: "Oversized payload",
      category: CATEGORY,
      expectedOutcome: "Rejected with 400 PAYLOAD_TOO_LARGE",
      actualOutcome: `Bond lock failed: ${bondResult.status} ${JSON.stringify(bondResult.data)}`,
      caught: false,
      details: "Could not complete test — bond lock did not succeed.",
    };
  }

  const bondId = bondResult.data.bondId as string;
  const exposureCents = Math.floor(100 / 1.2);

  const oversizedPayload = "X".repeat(payloadBytes);

  const actionResult = await signedPost(client, "/v1/actions/execute", {
    identityId: client.identityId,
    bondId,
    actionType: "input-validation-test",
    payload: { data: oversizedPayload },
    exposure_cents: exposureCents,
  });

  const caught = actionResult.status >= 400;
  return {
    scenarioId: "5.1",
    scenarioName: "Oversized payload",
    category: CATEGORY,
    expectedOutcome: `Rejected with 400 PAYLOAD_TOO_LARGE (${payloadBytes} bytes)`,
    actualOutcome: `${actionResult.status} ${JSON.stringify(actionResult.data)}`,
    caught,
    details: caught
      ? `AgentGate rejected the ${payloadBytes}-byte payload (${actionResult.status}).`
      : `AgentGate accepted a ${payloadBytes}-byte payload — payload size validation may be missing.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 5.2: TTL exceeding cap
// ---------------------------------------------------------------------------

async function attack5_2(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const ttlSeconds = (typeof params?.ttl_seconds === "number" ? params.ttl_seconds : 100000);

  const result = await signedPost(client, "/v1/bonds/lock", {
    identityId: client.identityId,
    amountCents: 100,
    currency: "USD",
    ttlSeconds,
    reason: "input-validation-test-5.2",
  });

  const caught = result.status >= 400;
  return {
    scenarioId: "5.2",
    scenarioName: "TTL exceeding cap",
    category: CATEGORY,
    expectedOutcome: `Rejected with 400 TTL_TOO_LONG (ttl=${ttlSeconds}s)`,
    actualOutcome: `${result.status} ${JSON.stringify(result.data)}`,
    caught,
    details: caught
      ? `AgentGate rejected TTL of ${ttlSeconds}s (${result.status}).`
      : `AgentGate accepted a TTL of ${ttlSeconds} seconds — TTL cap validation may be missing.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 5.3: Negative bond amount
// ---------------------------------------------------------------------------

async function attack5_3(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const amountCents = (typeof params?.amount_cents === "number" ? params.amount_cents : -100);

  const result = await signedPost(client, "/v1/bonds/lock", {
    identityId: client.identityId,
    amountCents,
    currency: "USD",
    ttlSeconds: 300,
    reason: "input-validation-test-5.3",
  });

  const caught = result.status >= 400;
  return {
    scenarioId: "5.3",
    scenarioName: "Negative bond amount",
    category: CATEGORY,
    expectedOutcome: `Rejected — ${amountCents} cents is invalid`,
    actualOutcome: `${result.status} ${JSON.stringify(result.data)}`,
    caught,
    details: caught
      ? `AgentGate rejected the bond amount of ${amountCents} cents (${result.status}).`
      : `AgentGate accepted a bond with ${amountCents} cents — amount validation may be missing.`,
  };
}

// ---------------------------------------------------------------------------
// Exported scenario list
// ---------------------------------------------------------------------------

export const inputValidationAttacks: AttackScenario[] = [
  {
    id: "5.1",
    name: "Oversized payload",
    category: CATEGORY,
    description: "Execute a bonded action with a payload string over 4096 bytes",
    expectedOutcome: "rejected with 400 PAYLOAD_TOO_LARGE",
    execute: (client, params?) => attack5_1(client, params),
  },
  {
    id: "5.2",
    name: "TTL exceeding cap",
    category: CATEGORY,
    description: "Lock a bond with ttlSeconds = 100000 (exceeds 86400s cap)",
    expectedOutcome: "rejected with 400 TTL_TOO_LONG",
    execute: (client, params?) => attack5_2(client, params),
  },
  {
    id: "5.3",
    name: "Negative bond amount",
    category: CATEGORY,
    description: "Lock a bond with amountCents = -100",
    expectedOutcome: "rejected — negative amount invalid",
    execute: (client, params?) => attack5_3(client, params),
  },
];
