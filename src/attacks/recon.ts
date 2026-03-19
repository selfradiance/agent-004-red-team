// Recon & side-channel scenarios — probes for information leakage and XSS vectors

import { randomUUID } from "node:crypto";
import type { AttackResult } from "../log";
import { signRequest } from "../agentgate-client";
import type { AttackScenario, AttackClient, AttackParams } from "./replay";
import { checkDashboardForRawHtml } from "../side-effects";

const CATEGORY = "Recon & Side-Channel";

// ---------------------------------------------------------------------------
// Attack 12.1: Unauthenticated endpoint data mapping
// ---------------------------------------------------------------------------

async function attack12_1(client: AttackClient, _params?: AttackParams): Promise<AttackResult> {
  // Probe common endpoints without any authentication headers
  const endpoints = [
    "/health",
    "/healthz",
    "/v1/stats",
    "/v1/identities",
    `/v1/identities/${client.identityId}`,
    "/v1/bonds",
    "/v1/actions",
    "/v1/markets",
  ];

  const results: { endpoint: string; status: number; hasData: boolean; fields: string[] }[] = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(new URL(endpoint, client.agentGateUrl), {
        method: "GET",
        headers: {},
      });

      let data: Record<string, unknown> = {};
      try {
        data = await response.json() as Record<string, unknown>;
      } catch {
        // Not JSON — that's fine
      }

      const fields = Object.keys(data).filter((k) => k !== "error" && k !== "message" && k !== "statusCode");
      results.push({
        endpoint,
        status: response.status,
        hasData: fields.length > 0,
        fields,
      });
    } catch {
      results.push({ endpoint, status: 0, hasData: false, fields: [] });
    }
  }

  const exposedEndpoints = results.filter((r) => r.status < 400 && r.hasData);
  const exposedSummary = exposedEndpoints.map((r) => `${r.endpoint} (${r.status}): ${r.fields.join(", ")}`).join("; ");

  return {
    scenarioId: "12.1",
    scenarioName: "Unauthenticated endpoint data mapping",
    category: CATEGORY,
    expectedOutcome: "Recon — catalog all data exposed without authentication",
    actualOutcome: `${exposedEndpoints.length}/${endpoints.length} endpoints returned data without auth`,
    caught: true,
    details: exposedEndpoints.length > 0
      ? `Exposed endpoints: ${exposedSummary}`
      : `No endpoints returned data without authentication — all ${endpoints.length} probed endpoints returned errors or empty responses.`,
  };
}

// ---------------------------------------------------------------------------
// Attack 12.2: XSS payload in action data
// ---------------------------------------------------------------------------

async function attack12_2(client: AttackClient, params?: AttackParams): Promise<AttackResult> {
  const xssVector = (typeof params?.xss_vector === "string" ? params.xss_vector : "script");

  let xssPayload: string;
  if (xssVector === "script") {
    xssPayload = '<script>alert("xss")</script>';
  } else if (xssVector === "onerror") {
    xssPayload = '<img src=x onerror="alert(1)">';
  } else {
    xssPayload = '<a href="javascript:alert(1)">click</a>';
  }

  // Lock a bond and execute an action with XSS in the payload
  const nonce = randomUUID();
  const timestamp = Date.now().toString();
  const bondPath = "/v1/bonds/lock";
  const bondBody = {
    identityId: client.identityId,
    amountCents: 100,
    currency: "USD",
    ttlSeconds: 300,
    reason: `xss-test-${xssVector}`,
  };
  const bondSig = signRequest(client.keys.publicKey, client.keys.privateKey, nonce, "POST", bondPath, timestamp, bondBody);

  const bondResponse = await fetch(new URL(bondPath, client.agentGateUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nonce": nonce,
      "x-agentgate-key": client.apiKey,
      "x-agentgate-timestamp": timestamp,
      "x-agentgate-signature": bondSig,
    },
    body: JSON.stringify(bondBody),
  });

  let bondData: Record<string, unknown>;
  try {
    bondData = await bondResponse.json() as Record<string, unknown>;
  } catch {
    bondData = {};
  }

  if (bondResponse.status >= 300) {
    return {
      scenarioId: "12.2",
      scenarioName: "XSS payload in action data",
      category: CATEGORY,
      expectedOutcome: "XSS payload stored and escaped in dashboard",
      actualOutcome: `Bond lock failed: ${bondResponse.status}`,
      caught: false,
      details: "Could not complete test — bond lock did not succeed.",
    };
  }

  const bondId = bondData.bondId as string;
  const exposureCents = Math.floor(100 / 1.2);

  // Execute action with XSS payload in actionType and payload fields
  const actionNonce = randomUUID();
  const actionTimestamp = Date.now().toString();
  const actionPath = "/v1/actions/execute";
  const actionBody = {
    identityId: client.identityId,
    bondId,
    actionType: xssPayload.slice(0, 128), // Truncate to max-length
    payload: { xss: xssPayload, vector: xssVector },
    exposure_cents: exposureCents,
  };
  const actionSig = signRequest(client.keys.publicKey, client.keys.privateKey, actionNonce, "POST", actionPath, actionTimestamp, actionBody);

  const actionResponse = await fetch(new URL(actionPath, client.agentGateUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nonce": actionNonce,
      "x-agentgate-key": client.apiKey,
      "x-agentgate-timestamp": actionTimestamp,
      "x-agentgate-signature": actionSig,
    },
    body: JSON.stringify(actionBody),
  });

  let actionData: Record<string, unknown>;
  try {
    actionData = await actionResponse.json() as Record<string, unknown>;
  } catch {
    actionData = {};
  }

  if (actionResponse.status >= 300) {
    // XSS payload may have been rejected by input validation — that's also a valid defense
    return {
      scenarioId: "12.2",
      scenarioName: "XSS payload in action data",
      category: CATEGORY,
      expectedOutcome: "XSS payload either rejected or stored-and-escaped",
      actualOutcome: `Action rejected: ${actionResponse.status} ${JSON.stringify(actionData)}`,
      caught: true,
      details: `AgentGate rejected the XSS payload in action data (${actionResponse.status}) — input validation caught the ${xssVector} vector.`,
    };
  }

  // XSS was stored — check if dashboard escapes it using side-effect utility
  const dashboardContainsRawHtml = await checkDashboardForRawHtml(client.agentGateUrl, xssPayload);
  const dashboardChecked = dashboardContainsRawHtml !== null;
  const xssEscaped = dashboardContainsRawHtml !== true;

  return {
    scenarioId: "12.2",
    scenarioName: "XSS payload in action data",
    category: CATEGORY,
    expectedOutcome: "XSS payload stored but escaped in dashboard output",
    actualOutcome: `Action stored with ${xssVector} payload. Dashboard checked: ${dashboardChecked}. Escaped: ${xssEscaped}.`,
    caught: xssEscaped,
    details: dashboardChecked
      ? (xssEscaped
        ? `XSS ${xssVector} payload was stored but properly escaped in dashboard HTML — escapeHtml is working.`
        : `XSS ${xssVector} payload appears UNESCAPED in dashboard HTML — potential stored XSS vulnerability.`)
      : `XSS ${xssVector} payload was stored in action data. Dashboard not reachable to verify escaping — manual check recommended.`,
    sideEffects: {
      dashboardContainsRawHtml: dashboardContainsRawHtml ?? undefined,
      additionalNotes: dashboardChecked ? `Tested ${xssVector} vector against /dashboard` : "Dashboard unreachable",
    },
  };
}

// ---------------------------------------------------------------------------
// Exported scenario list
// ---------------------------------------------------------------------------

export const reconAttacks: AttackScenario[] = [
  {
    id: "12.1",
    name: "Unauthenticated endpoint data mapping",
    category: CATEGORY,
    description: "Probe common endpoints without auth to catalog exposed data",
    expectedOutcome: "recon — map exposed data fields",
    execute: (client, params?) => attack12_1(client, params),
  },
  {
    id: "12.2",
    name: "XSS payload in action data",
    category: CATEGORY,
    description: "Store XSS payloads in action data, check dashboard for escaping",
    expectedOutcome: "XSS payload escaped in dashboard",
    execute: (client, params?) => attack12_2(client, params),
  },
];
