// Rate limit attack scenarios — tests whether AgentGate throttles excessive requests

import { generateKeyPairSync, randomUUID } from "node:crypto";
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
// Helpers for multi-identity scenarios
// ---------------------------------------------------------------------------

function freshKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.from(publicJwk.x!, "base64url").toString("base64"),
    privateKey: Buffer.from(privateJwk.d!, "base64url").toString("base64"),
  };
}

async function registerAndGetId(
  client: AttackClient,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const result = await signedPost(
    { ...client, keys: { publicKey, privateKey } } as AttackClient,
    "/v1/identities",
    { publicKey },
  );
  if (result.status >= 300) {
    throw new Error(`Failed to register identity: ${result.status} ${JSON.stringify(result.data)}`);
  }
  return result.data.identityId as string;
}

// Need a version of signedPost that takes explicit keys for Sybil identities
async function signedPostWithKeys(
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

// ---------------------------------------------------------------------------
// Attack 6.2: Sybil rate-limit bypass
// ---------------------------------------------------------------------------

async function attack6_2(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const identityCount = (typeof params?.identity_count === "number" ? params.identity_count : 3);
  const burstSize = (typeof params?.burst_size === "number" ? params.burst_size : 9);

  // Create N fresh identities, each with their own keypair
  const identities: { publicKey: string; privateKey: string; identityId: string }[] = [];

  for (let i = 0; i < identityCount; i++) {
    const keys = freshKeypair();
    const identityId = await signedPostWithKeys(
      client.agentGateUrl, client.apiKey,
      keys.publicKey, keys.privateKey,
      "/v1/identities",
      { publicKey: keys.publicKey },
    ).then((r) => {
      if (r.status >= 300) throw new Error(`Identity registration failed: ${r.status}`);
      return r.data.identityId as string;
    });
    identities.push({ ...keys, identityId });
  }

  // Each identity locks a bond and fires burstSize executes (under per-identity limit of 10)
  let totalSucceeded = 0;
  let totalRateLimited = 0;

  for (const id of identities) {
    // Lock a bond for this identity
    const bondResult = await signedPostWithKeys(
      client.agentGateUrl, client.apiKey,
      id.publicKey, id.privateKey,
      "/v1/bonds/lock",
      {
        identityId: id.identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "rate-limit-test-6.2",
      },
    );

    if (bondResult.status >= 300) continue;
    const bondId = bondResult.data.bondId as string;

    for (let j = 0; j < burstSize; j++) {
      const result = await signedPostWithKeys(
        client.agentGateUrl, client.apiKey,
        id.publicKey, id.privateKey,
        "/v1/actions/execute",
        {
          identityId: id.identityId,
          bondId,
          actionType: "rate-limit-test",
          payload: { test: "6.2", identity: id.identityId.slice(0, 8), attempt: j + 1 },
          exposure_cents: 10,
        },
      );
      if (result.status < 300) totalSucceeded++;
      if (result.status === 429) totalRateLimited++;
    }
  }

  const totalAttempts = identityCount * burstSize;
  // If all succeeded, Sybil bypass worked — rate limiting is per-identity only, no global limit
  // This is informational — AgentGate's rate limit IS per-identity by design
  const allSucceeded = totalRateLimited === 0;

  return {
    scenarioId: "6.2",
    scenarioName: "Sybil rate-limit bypass",
    category: CATEGORY,
    expectedOutcome: `${identityCount} identities × ${burstSize} executes each — probing whether Sybil circumvents rate limit`,
    actualOutcome: `${totalSucceeded}/${totalAttempts} succeeded, ${totalRateLimited} rate-limited`,
    // caught: true because rate limiting is per-identity by design (documented known limitation).
    // Sybil bypass is expected behavior, not a new vulnerability finding.
    caught: true,
    details: allSucceeded
      ? `All ${totalSucceeded} requests succeeded across ${identityCount} identities — rate limit is per-identity only, Sybil identities bypass it. This is a known design limitation.`
      : `${totalRateLimited} requests were rate-limited across ${identityCount} identities — some form of global or aggregate rate limiting may be in place.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 6.3: Bucket expiry and re-burst
// ---------------------------------------------------------------------------

async function attack6_3(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const waitSeconds = (typeof params?.wait_seconds === "number" ? params.wait_seconds : 61);

  // Use a fresh identity so rate limit state is clean
  const keys = freshKeypair();
  const identityId = await signedPostWithKeys(
    client.agentGateUrl, client.apiKey,
    keys.publicKey, keys.privateKey,
    "/v1/identities",
    { publicKey: keys.publicKey },
  ).then((r) => {
    if (r.status >= 300) throw new Error(`Identity registration failed: ${r.status}`);
    return r.data.identityId as string;
  });

  // Lock a large bond
  const bondResult = await signedPostWithKeys(
    client.agentGateUrl, client.apiKey,
    keys.publicKey, keys.privateKey,
    "/v1/bonds/lock",
    {
      identityId,
      amountCents: 5000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "rate-limit-test-6.3",
    },
  );

  if (bondResult.status >= 300) {
    return {
      scenarioId: "6.3",
      scenarioName: "Bucket expiry and re-burst",
      category: CATEGORY,
      expectedOutcome: "After rate limit bucket expires, second burst succeeds",
      actualOutcome: `Bond lock failed: ${bondResult.status} ${JSON.stringify(bondResult.data)}`,
      caught: false,
      details: "Could not complete test — bond lock did not succeed.",
    };
  }

  const bondId = bondResult.data.bondId as string;
  const sybilClient: AttackClient = {
    agentGateUrl: client.agentGateUrl,
    apiKey: client.apiKey,
    keys: { publicKey: keys.publicKey, privateKey: keys.privateKey },
    identityId,
  };

  // First burst: 11 requests to trigger rate limit
  let firstBurstRateLimited = 0;
  for (let i = 0; i < 11; i++) {
    const result = await signedPost(sybilClient, "/v1/actions/execute", {
      identityId,
      bondId,
      actionType: "rate-limit-test",
      payload: { test: "6.3", burst: 1, attempt: i + 1 },
      exposure_cents: 10,
    });
    if (result.status === 429) firstBurstRateLimited++;
  }

  if (firstBurstRateLimited === 0) {
    return {
      scenarioId: "6.3",
      scenarioName: "Bucket expiry and re-burst",
      category: CATEGORY,
      expectedOutcome: "After rate limit bucket expires, second burst succeeds",
      actualOutcome: "First burst was not rate-limited — cannot test bucket expiry",
      caught: false,
      details: "First burst of 11 requests was not rate-limited. Cannot test bucket expiry behavior.",
    };
  }

  // Wait for the bucket to expire
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

  // Second burst: should succeed if the bucket has expired
  let secondBurstSucceeded = 0;
  let secondBurstRateLimited = 0;
  for (let i = 0; i < 5; i++) {
    const result = await signedPost(sybilClient, "/v1/actions/execute", {
      identityId,
      bondId,
      actionType: "rate-limit-test",
      payload: { test: "6.3", burst: 2, attempt: i + 1 },
      exposure_cents: 10,
    });
    if (result.status < 300) secondBurstSucceeded++;
    if (result.status === 429) secondBurstRateLimited++;
  }

  const bucketExpired = secondBurstSucceeded > 0;
  return {
    scenarioId: "6.3",
    scenarioName: "Bucket expiry and re-burst",
    category: CATEGORY,
    expectedOutcome: `After ${waitSeconds}s wait, rate limit bucket expires and second burst succeeds`,
    actualOutcome: `First burst: ${firstBurstRateLimited} rate-limited. Wait: ${waitSeconds}s. Second burst: ${secondBurstSucceeded}/5 succeeded, ${secondBurstRateLimited} rate-limited.`,
    // caught: true because this is a behavioral probe, not a vulnerability test.
    // Non-expiry would mean stricter rate limiting, which is more secure, not less.
    caught: true,
    details: bucketExpired
      ? `Rate limit bucket expired after ${waitSeconds}s — second burst succeeded (${secondBurstSucceeded}/5). Bucket cleanup is working.`
      : `Rate limit bucket did NOT expire after ${waitSeconds}s — second burst still rate-limited. Bucket may persist longer than expected.`,
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
  {
    id: "6.2",
    name: "Sybil rate-limit bypass",
    category: CATEGORY,
    description: "Create N identities, burst executes from each, all under per-identity limit",
    expectedOutcome: "probing — Sybil bypasses per-identity rate limit by design",
    execute: (client, params?) => attack6_2(client, params),
  },
  {
    id: "6.3",
    name: "Bucket expiry and re-burst",
    category: CATEGORY,
    description: "Hit rate limit, wait for bucket expiry, burst again",
    expectedOutcome: "second burst succeeds after bucket expires",
    execute: (client, params?) => attack6_3(client, params),
  },
];
