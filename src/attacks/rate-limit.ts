// Rate limit attack scenarios — tests whether AgentGate throttles excessive requests

import { randomUUID } from "node:crypto";
import type { AttackResult } from "../log";
import { signRequest } from "../agentgate-client";
import type { AttackScenario, AttackClient, AttackParams } from "./replay";

const CATEGORY = "Rate Limiting";

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
// Attack 6.1: Exceed execution rate limit
// ---------------------------------------------------------------------------

async function attack6_1(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const requestCount = (typeof params?.request_count === "number" ? params.request_count : 11);
  const exposurePerRequest = (typeof params?.exposure_per_request === "number" ? params.exposure_per_request : 10);

  // Lock a bond large enough to cover all requests without hitting capacity
  const bondAmount = exposurePerRequest * requestCount * 2;
  const bondResult = await signedPost(client, "/v1/bonds/lock", {
    identityId: client.identityId,
    amountCents: bondAmount,
    currency: "USD",
    ttlSeconds: 300,
    reason: "rate-limit-test-6.1",
  });

  if (bondResult.status >= 300) {
    return {
      scenarioId: "6.1",
      scenarioName: "Exceed execution rate limit",
      category: CATEGORY,
      expectedOutcome: `Request ${requestCount} rejected — rate limit exceeded`,
      actualOutcome: `Bond lock failed: ${bondResult.status} ${JSON.stringify(bondResult.data)}`,
      caught: false,
      details: "Could not complete test — bond lock did not succeed.",
    };
  }

  const bondId = bondResult.data.bondId as string;

  // Fire requests in rapid succession
  const results: { index: number; status: number; data: Record<string, unknown> }[] = [];

  for (let i = 0; i < requestCount; i++) {
    const actionResult = await signedPost(client, "/v1/actions/execute", {
      identityId: client.identityId,
      bondId,
      actionType: "rate-limit-test",
      payload: { attempt: i + 1 },
      exposure_cents: exposurePerRequest,
    });
    results.push({ index: i + 1, status: actionResult.status, data: actionResult.data });
  }

  // Count how many succeeded vs were rate-limited
  const succeeded = results.filter((r) => r.status < 300).length;
  const rateLimited = results.filter((r) => r.status === 429).length;
  const lastResult = results[results.length - 1];

  const caught = rateLimited > 0;
  return {
    scenarioId: "6.1",
    scenarioName: "Exceed execution rate limit",
    category: CATEGORY,
    expectedOutcome: `Rate limit hit within ${requestCount} requests`,
    actualOutcome: `${succeeded} succeeded, ${rateLimited} rate-limited. Last request: ${lastResult.status} ${JSON.stringify(lastResult.data)}`,
    caught,
    details: caught
      ? `AgentGate rate-limited after ${succeeded} of ${requestCount} requests (${rateLimited} rejected with 429).`
      : `All ${succeeded} of ${requestCount} requests succeeded — rate limiting may not be enforced.`,
  };
}

// ---------------------------------------------------------------------------
// Exported scenario list
// ---------------------------------------------------------------------------

export const rateLimitAttacks: AttackScenario[] = [
  {
    id: "6.1",
    name: "Exceed execution rate limit",
    category: CATEGORY,
    description: "Fire 11 execute requests in rapid succession from one identity (limit is 10/60s)",
    expectedOutcome: "11th request rate-limited with 429",
    execute: (client, params?) => attack6_1(client, params),
  },
];
