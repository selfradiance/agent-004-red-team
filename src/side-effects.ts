// Side-effect collection utilities — supplementary checks for richer attack results
// All functions are error-safe: they catch all errors and return null. Never crash an attack.

const SIDE_EFFECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Get reputation score for an identity
// ---------------------------------------------------------------------------

export async function getReputation(
  agentGateUrl: string,
  identityId: string,
): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIDE_EFFECT_TIMEOUT_MS);

  try {
    const response = await fetch(new URL(`/v1/identities/${identityId}`, agentGateUrl), {
      method: "GET",
      signal: controller.signal,
    });

    if (response.status >= 300) return null;

    const data = await response.json() as Record<string, unknown>;
    if (typeof data.reputationScore === "number") return data.reputationScore;
    if (typeof data.reputation === "number") return data.reputation;
    if (typeof data.score === "number") return data.score;

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Get bond status
// ---------------------------------------------------------------------------

export async function getBondStatus(
  agentGateUrl: string,
  bondId: string,
  restKey: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIDE_EFFECT_TIMEOUT_MS);

  try {
    // Try GET /v1/bonds/:id — may or may not exist in AgentGate
    const response = await fetch(new URL(`/v1/bonds/${bondId}`, agentGateUrl), {
      method: "GET",
      headers: {
        "x-agentgate-key": restKey,
      },
      signal: controller.signal,
    });

    if (response.status >= 300) return null;

    const data = await response.json() as Record<string, unknown>;
    if (typeof data.status === "string") return data.status;

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  // TODO: If AgentGate doesn't have a GET bond endpoint, this will always return null.
  // May need to check dashboard data instead.
}

// ---------------------------------------------------------------------------
// Check dashboard for unescaped HTML
// ---------------------------------------------------------------------------

export async function checkDashboardForRawHtml(
  agentGateUrl: string,
  testPayload: string,
  dashboardKey?: string,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIDE_EFFECT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (dashboardKey) {
      headers["authorization"] = `Basic ${Buffer.from(`admin:${dashboardKey}`).toString("base64")}`;
    }

    const response = await fetch(new URL("/dashboard", agentGateUrl), {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (response.status >= 300) return null;

    const html = await response.text();

    // Check if the raw test payload appears unescaped in the HTML
    // The payload should be escaped (e.g., <script> → &lt;script&gt;)
    // If the literal payload appears, it's unescaped
    return html.includes(testPayload);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
