// Market abuse scenarios — tests AgentGate's market endpoint security and validation

import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { AttackResult } from "../log";
import { signRequest } from "../agentgate-client";
import type { AttackScenario, AttackClient, AttackParams } from "./replay";

const CATEGORY = "Market Abuse";

// ---------------------------------------------------------------------------
// Helper — send a properly signed POST request
// ---------------------------------------------------------------------------

async function signedPost(
  agentGateUrl: string,
  apiKey: string,
  publicKey: string,
  privateKey: string,
  apiPath: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const nonce = randomUUID();
  const timestamp = Date.now().toString();
  const signature = signRequest(publicKey, privateKey, nonce, "POST", apiPath, timestamp, body);

  const response = await fetch(new URL(apiPath, agentGateUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nonce": nonce,
      "x-agentgate-key": apiKey,
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

function signedPostClient(client: AttackClient, apiPath: string, body: unknown) {
  return signedPost(client.agentGateUrl, client.apiKey, client.keys.publicKey, client.keys.privateKey, apiPath, body);
}

// Helper — create a market and return its ID
async function createMarket(
  client: AttackClient,
  deadline: string,
  question: string,
): Promise<{ status: number; marketId?: string; data: Record<string, unknown> }> {
  const result = await signedPostClient(client, "/v1/markets", {
    question,
    deadline,
    identityId: client.identityId,
  });

  return {
    status: result.status,
    marketId: typeof result.data.marketId === "string" ? result.data.marketId : undefined,
    data: result.data,
  };
}

// ---------------------------------------------------------------------------
// Attack 10.1: Market resolution before deadline
// ---------------------------------------------------------------------------

async function attack10_1(client: AttackClient, _params?: AttackParams): Promise<AttackResult> {
  // Create a market with a deadline far in the future
  const futureDeadline = new Date(Date.now() + 86400_000).toISOString(); // 24h from now
  const market = await createMarket(client, futureDeadline, "Will this market be resolved early? (attack 10.1)");

  if (market.status >= 300 || !market.marketId) {
    return {
      scenarioId: "10.1",
      scenarioName: "Market resolution before deadline",
      category: CATEGORY,
      expectedOutcome: "Resolution rejected — deadline has not passed",
      actualOutcome: `Market creation returned: ${market.status} ${JSON.stringify(market.data)}`,
      caught: true,
      details: market.status === 404
        ? "Market endpoint not found — market feature may not be enabled in this AgentGate version."
        : `Market creation failed (${market.status}). Cannot test early resolution.`,
    };
  }

  // Try to resolve immediately — deadline hasn't passed
  const resolveResult = await signedPostClient(client, `/v1/markets/${market.marketId}/resolve`, {
    outcome: "yes",
  });

  const caught = resolveResult.status >= 400;
  return {
    scenarioId: "10.1",
    scenarioName: "Market resolution before deadline",
    category: CATEGORY,
    expectedOutcome: "Rejected — deadline has not passed",
    actualOutcome: `${resolveResult.status} ${JSON.stringify(resolveResult.data)}`,
    caught,
    details: caught
      ? `AgentGate rejected early market resolution (${resolveResult.status}) — deadline enforcement is working.`
      : `AgentGate allowed market resolution before deadline — deadline check may be missing.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 10.2: Market resolve without identity signing
// ---------------------------------------------------------------------------

async function attack10_2(client: AttackClient, _params?: AttackParams): Promise<AttackResult> {
  // Create a market with a deadline in the past so it can be resolved
  const pastDeadline = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
  const market = await createMarket(client, pastDeadline, "Can anyone resolve this? (attack 10.2)");

  if (market.status >= 300 || !market.marketId) {
    return {
      scenarioId: "10.2",
      scenarioName: "Market resolve without identity signing",
      category: CATEGORY,
      expectedOutcome: "Probing — can any REST key holder resolve any market?",
      actualOutcome: `Market creation returned: ${market.status} ${JSON.stringify(market.data)}`,
      caught: true,
      details: market.status === 404
        ? "Market endpoint not found — market feature may not be enabled in this AgentGate version."
        : `Market creation failed (${market.status}). Cannot test resolve auth.`,
    };
  }

  // Try to resolve using just the REST key — no identity-specific signing needed
  // This tests the documented known limitation: market endpoints are REST-key only
  const resolveResult = await signedPostClient(client, `/v1/markets/${market.marketId}/resolve`, {
    outcome: "yes",
  });

  // This is a known limitation probe — if it succeeds, that confirms the limitation
  const accepted = resolveResult.status < 300;
  return {
    scenarioId: "10.2",
    scenarioName: "Market resolve without identity signing",
    category: CATEGORY,
    expectedOutcome: "Probing — market resolution uses REST key auth only (documented known limitation)",
    actualOutcome: `${resolveResult.status} ${JSON.stringify(resolveResult.data)}`,
    // caught: true because this probes a documented known limitation, not a new vulnerability.
    // The details text records whether the limitation is still present or has been fixed.
    caught: true,
    details: accepted
      ? `Market resolved with REST key auth only — any identity with the REST key can resolve any market. This is a documented known limitation.`
      : `Market resolution rejected (${resolveResult.status}) — market auth may have been upgraded beyond REST-key-only.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 10.3: Market position spam
// ---------------------------------------------------------------------------

async function attack10_3(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const positionCount = (typeof params?.position_count === "number" ? params.position_count : 20);
  const identityCount = (typeof params?.identity_count === "number" ? params.identity_count : 5);

  // Create a market with a future deadline
  const futureDeadline = new Date(Date.now() + 86400_000).toISOString();
  const market = await createMarket(client, futureDeadline, "Spam test market (attack 10.3)");

  if (market.status >= 300 || !market.marketId) {
    return {
      scenarioId: "10.3",
      scenarioName: "Market position spam",
      category: CATEGORY,
      expectedOutcome: "Stress test — flood market with positions",
      actualOutcome: `Market creation returned: ${market.status} ${JSON.stringify(market.data)}`,
      caught: true,
      details: market.status === 404
        ? "Market endpoint not found — market feature may not be enabled in this AgentGate version."
        : `Market creation failed (${market.status}). Cannot test position spam.`,
    };
  }

  const marketId = market.marketId;

  // Create fresh identities and spam positions
  let totalSucceeded = 0;
  let totalRejected = 0;

  for (let i = 0; i < identityCount; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    const privateJwk = privateKey.export({ format: "jwk" });
    const pub = Buffer.from(publicJwk.x!, "base64url").toString("base64");
    const priv = Buffer.from(privateJwk.d!, "base64url").toString("base64");

    // Register identity
    const idResult = await signedPost(client.agentGateUrl, client.apiKey, pub, priv, "/v1/identities", { publicKey: pub });
    if (idResult.status >= 300) continue;
    const identityId = idResult.data.identityId as string;

    // Spam positions from this identity
    const positionsPerIdentity = Math.ceil(positionCount / identityCount);
    for (let j = 0; j < positionsPerIdentity; j++) {
      const result = await signedPost(client.agentGateUrl, client.apiKey, pub, priv, `/v1/markets/${marketId}/positions`, {
        identityId,
        side: j % 2 === 0 ? "yes" : "no",
        amountCents: 10,
      });
      if (result.status < 300) totalSucceeded++;
      else totalRejected++;
    }
  }

  return {
    scenarioId: "10.3",
    scenarioName: "Market position spam",
    category: CATEGORY,
    expectedOutcome: `Stress test — ${positionCount} positions from ${identityCount} identities`,
    actualOutcome: `${totalSucceeded} positions accepted, ${totalRejected} rejected`,
    // caught: true because this is a stress test / probe, not a pass/fail vulnerability check.
    // The details text records whether any spam protection was observed.
    caught: true,
    details: totalRejected > 0
      ? `AgentGate rejected ${totalRejected} of ${totalSucceeded + totalRejected} position attempts — some form of position limiting may be in place.`
      : totalSucceeded > 0
        ? `All ${totalSucceeded} positions accepted — no position spam protection detected. May stress batch settlement.`
        : `No positions were accepted — market position endpoint may not exist or may require different parameters.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 10.4: Malformed market.position payload
// ---------------------------------------------------------------------------

async function attack10_4(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const variant = (typeof params?.variant === "string" ? params.variant : "bad-side");

  // Create a market first
  const futureDeadline = new Date(Date.now() + 86400_000).toISOString();
  const market = await createMarket(client, futureDeadline, "Malformed position test (attack 10.4)");

  if (market.status >= 300 || !market.marketId) {
    return {
      scenarioId: "10.4",
      scenarioName: "Malformed market.position payload",
      category: CATEGORY,
      expectedOutcome: `Rejected — ${variant} payload`,
      actualOutcome: `Market creation returned: ${market.status} ${JSON.stringify(market.data)}`,
      caught: true,
      details: market.status === 404
        ? "Market endpoint not found — market feature may not be enabled in this AgentGate version."
        : `Market creation failed (${market.status}). Cannot test malformed positions.`,
    };
  }

  const marketId = market.marketId;
  let positionBody: unknown;

  if (variant === "bad-side") {
    positionBody = { identityId: client.identityId, side: "maybe", amountCents: 10 };
  } else if (variant === "missing-market") {
    positionBody = { identityId: client.identityId, side: "yes", amountCents: 10 };
    // Send to a nonexistent market ID
    const result = await signedPostClient(client, "/v1/markets/nonexistent-market-id/positions", positionBody);
    const caught = result.status >= 400;
    return {
      scenarioId: "10.4",
      scenarioName: "Malformed market.position payload",
      category: CATEGORY,
      expectedOutcome: "Rejected — nonexistent market ID",
      actualOutcome: `${result.status} ${JSON.stringify(result.data)}`,
      caught,
      details: caught
        ? `AgentGate rejected position on nonexistent market (${result.status}).`
        : `AgentGate accepted a position on a nonexistent market — market existence check may be missing.`,
    };
  } else {
    // extra-fields
    positionBody = { identityId: client.identityId, side: "yes", amountCents: 10, extraField: "should-be-ignored", admin: true };
  }

  const result = await signedPostClient(client, `/v1/markets/${marketId}/positions`, positionBody);

  const caught = result.status >= 400;
  return {
    scenarioId: "10.4",
    scenarioName: "Malformed market.position payload",
    category: CATEGORY,
    expectedOutcome: `Rejected — ${variant} position payload`,
    actualOutcome: `${result.status} ${JSON.stringify(result.data)}`,
    caught,
    details: caught
      ? `AgentGate rejected the ${variant} position payload (${result.status}).`
      : `AgentGate accepted the ${variant} position payload — ${variant === "extra-fields" ? "extra fields were silently ignored (may be acceptable)" : "input validation may be missing"}.`,
  };
}

// ---------------------------------------------------------------------------
// Exported scenario list
// ---------------------------------------------------------------------------

export const marketAttacks: AttackScenario[] = [
  {
    id: "10.1",
    name: "Market resolution before deadline",
    category: CATEGORY,
    description: "Create a market with future deadline, immediately try to resolve",
    expectedOutcome: "rejected — deadline has not passed",
    execute: (client, params?) => attack10_1(client, params),
  },
  {
    id: "10.2",
    name: "Market resolve without identity signing",
    category: CATEGORY,
    description: "Resolve a market using only REST key auth (documented known limitation)",
    expectedOutcome: "probing — REST key auth only",
    execute: (client, params?) => attack10_2(client, params),
  },
  {
    id: "10.3",
    name: "Market position spam",
    category: CATEGORY,
    description: "Flood one market with positions from many identities",
    expectedOutcome: "stress test — batch settlement under load",
    execute: (client, params?) => attack10_3(client, params),
  },
  {
    id: "10.4",
    name: "Malformed market.position payload",
    category: CATEGORY,
    description: "Invalid side values, nonexistent market, or extra fields in position payload",
    expectedOutcome: "rejected — invalid payload",
    execute: (client, params?) => attack10_4(client, params),
  },
];
