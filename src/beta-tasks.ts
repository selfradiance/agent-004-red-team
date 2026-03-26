// Beta team task definitions for Stage 5 — trust-building (legitimate actions)
// and offensive trust-spending (attacks that exploit accumulated reputation).
// Beta agents build standing in early rounds, then spend it offensively.
//
// AgentGate enforces dual-control: the identity that executes an action cannot
// resolve it. A different "resolver" identity must resolve. Beta agents resolve
// each other's actions within the team.

import { postBond, executeBondedAction, resolveAction, signRequest } from "./agentgate-client";
import { getReputation } from "./side-effects";
import { randomUUID } from "node:crypto";
import type { AgentKeys } from "./agentgate-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BetaIdentity {
  keys: AgentKeys;
  identityId: string;
  agentId: string;
}

export interface BetaTaskResult {
  actionName: string;
  caught: boolean;
  details: string;
  reputationBefore: number | null;
  reputationAfter: number | null;
}

// ---------------------------------------------------------------------------
// Trust-building actions (early rounds — legitimate operations)
// ---------------------------------------------------------------------------

/**
 * Complete a clean bond lifecycle: lock bond → execute valid action → resolve successfully.
 * This is a legitimate operation that builds reputation.
 * Requires a resolver identity (different from executor) due to AgentGate's dual-control.
 */
export async function cleanBondCycle(
  identity: BetaIdentity,
  resolver: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, identity.identityId);

  try {
    // Step 1: Lock a small bond
    const bondData = await postBond(identity.keys, identity.identityId, 10, 60, "Legitimate operation — trust building");

    const bondId = bondData.bondId as string;

    // Step 2: Execute a valid action within bond capacity
    const actionData = await executeBondedAction(
      identity.keys,
      identity.identityId,
      bondId,
      "data_query",
      { query: "status_check", timestamp: Date.now() },
      5,
    );

    const actionId = actionData.actionId as string;

    // Step 3: Resolve successfully (resolver identity signs the resolve request)
    await resolveAction(resolver.keys, resolver.identityId, actionId, "success");

    const repAfter = await getReputation(targetUrl, identity.identityId);

    return {
      actionName: "cleanBondCycle",
      caught: false,
      details: `Clean bond cycle completed. Bond: ${bondId.slice(0, 12)}..., Action: ${actionId.slice(0, 12)}...`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  } catch (err) {
    const repAfter = await getReputation(targetUrl, identity.identityId);
    return {
      actionName: "cleanBondCycle",
      caught: true,
      details: `Clean bond cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  }
}

/**
 * Run multiple clean bond cycles in sequence to build standing faster.
 */
export async function multipleCleanCycles(
  identity: BetaIdentity,
  resolver: BetaIdentity,
  targetUrl: string,
  count: number = 3,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, identity.identityId);
  const results: string[] = [];
  let failures = 0;

  for (let i = 0; i < count; i++) {
    const result = await cleanBondCycle(identity, resolver, targetUrl);
    results.push(`Cycle ${i + 1}: ${result.caught ? "FAILED" : "OK"}`);
    if (result.caught) failures++;
  }

  const repAfter = await getReputation(targetUrl, identity.identityId);

  return {
    actionName: "multipleCleanCycles",
    caught: failures === count,
    details: `${count} cycles attempted, ${count - failures} succeeded, ${failures} failed. ${results.join("; ")}`,
    reputationBefore: repBefore,
    reputationAfter: repAfter,
  };
}

/**
 * Check the current reputation/standing for this identity.
 */
export async function checkReputation(
  identity: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const reputation = await getReputation(targetUrl, identity.identityId);

  return {
    actionName: "checkReputation",
    caught: false,
    details: reputation !== null
      ? `Reputation score: ${reputation}`
      : "Reputation data unavailable (endpoint may not expose score)",
    reputationBefore: reputation,
    reputationAfter: reputation,
  };
}

// ---------------------------------------------------------------------------
// Offensive trust-spending actions (late rounds — exploit accumulated trust)
// ---------------------------------------------------------------------------

/**
 * Attempt to lock a bond significantly larger than the normal agent budget.
 * Tests whether ANY bond capacity limit exists — not whether trust unlocks
 * higher caps. Verified: AgentGate accepts 500¢ from fresh identities with
 * zero history, so acceptance here is an identity-agnostic capacity gap,
 * not a reputation-based privilege escalation.
 */
export async function highValueBondAttempt(
  identity: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, identity.identityId);

  try {
    // Attempt a bond 5x the normal agent budget — tests whether any cap exists
    const bondData = await postBond(identity.keys, identity.identityId, 500, 120, "High-value operation — testing capacity limits");
    const bondId = bondData.bondId as string;

    const repAfter = await getReputation(targetUrl, identity.identityId);

    // Bond accepted — this is "uncaught" because AgentGate has no reputation-gated
    // capacity enforcement. A fresh identity gets the same result.
    return {
      actionName: "highValueBondAttempt",
      caught: false,
      details: `High-value bond (500¢) accepted — no reputation-gated capacity enforcement. Bond: ${bondId.slice(0, 12)}... A fresh identity with zero history also gets 500¢ accepted.`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  } catch (err) {
    const repAfter = await getReputation(targetUrl, identity.identityId);
    return {
      actionName: "highValueBondAttempt",
      caught: true,
      details: `High-value bond (500¢) rejected: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  }
}

/**
 * Attempt a burst of rapid executions that would normally trigger rate limiting.
 * Tests whether reputation provides rate-limit leniency.
 * Resolver identity resolves each action in the burst.
 */
export async function rapidExecutionBurst(
  identity: BetaIdentity,
  resolver: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, identity.identityId);

  try {
    // Lock a bond to execute against
    const bondData = await postBond(identity.keys, identity.identityId, 50, 60, "Burst test — rate limit probe");
    const bondId = bondData.bondId as string;

    let succeeded = 0;
    let rateLimited = false;
    const burstCount = 8;

    for (let i = 0; i < burstCount; i++) {
      try {
        const actionData = await executeBondedAction(
          identity.keys,
          identity.identityId,
          bondId,
          "data_query",
          { query: `burst_${i}`, timestamp: Date.now() },
          3,
        );
        const actionId = actionData.actionId as string;
        await resolveAction(resolver.keys, resolver.identityId, actionId, "success");
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("429") || msg.includes("rate") || msg.includes("limit")) {
          rateLimited = true;
          break;
        }
        // Other error — bond capacity exhaustion is expected
        break;
      }
    }

    const repAfter = await getReputation(targetUrl, identity.identityId);

    if (rateLimited) {
      return {
        actionName: "rapidExecutionBurst",
        caught: true,
        details: `Rate limited after ${succeeded}/${burstCount} rapid executions. Reputation did not provide leniency.`,
        reputationBefore: repBefore,
        reputationAfter: repAfter,
      };
    }

    return {
      actionName: "rapidExecutionBurst",
      caught: false,
      details: `${succeeded}/${burstCount} rapid executions completed without rate limiting. Possible reputation-based leniency.`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  } catch (err) {
    const repAfter = await getReputation(targetUrl, identity.identityId);
    return {
      actionName: "rapidExecutionBurst",
      caught: true,
      details: `Burst test failed to start: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  }
}

/**
 * Trusted identity attempts to resolve an action belonging to a different identity.
 * Tests whether reputation grants cross-identity privileges.
 */
export async function resolveOtherIdentityAction(
  trustedIdentity: BetaIdentity,
  freshIdentity: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, trustedIdentity.identityId);

  try {
    // Fresh identity creates a bond and action
    const bondData = await postBond(freshIdentity.keys, freshIdentity.identityId, 10, 60, "Cross-identity test target");
    const bondId = bondData.bondId as string;

    const actionData = await executeBondedAction(
      freshIdentity.keys,
      freshIdentity.identityId,
      bondId,
      "data_query",
      { query: "cross_identity_target" },
      5,
    );
    const actionId = actionData.actionId as string;

    // Trusted identity attempts to resolve the fresh identity's action
    await resolveAction(trustedIdentity.keys, trustedIdentity.identityId, actionId, "success");

    const repAfter = await getReputation(targetUrl, trustedIdentity.identityId);

    return {
      actionName: "resolveOtherIdentityAction",
      caught: false,
      details: `Trusted identity successfully resolved another identity's action (${actionId.slice(0, 12)}...). Cross-identity privilege escalation possible.`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  } catch (err) {
    const repAfter = await getReputation(targetUrl, trustedIdentity.identityId);
    return {
      actionName: "resolveOtherIdentityAction",
      caught: true,
      details: `Cross-identity resolve rejected: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  }
}

/**
 * Intentionally get slashed, then attempt to continue operating.
 * Tests whether accumulated reputation provides resilience after a penalty.
 * Resolver identity resolves the actions.
 */
export async function postSlashRecovery(
  identity: BetaIdentity,
  resolver: BetaIdentity,
  targetUrl: string,
): Promise<BetaTaskResult> {
  const repBefore = await getReputation(targetUrl, identity.identityId);

  try {
    // Step 1: Lock a bond and execute an action, then resolve as "failed" to trigger slash
    const bondData = await postBond(identity.keys, identity.identityId, 10, 60, "Slash recovery test — will fail intentionally");
    const bondId = bondData.bondId as string;

    const actionData = await executeBondedAction(
      identity.keys,
      identity.identityId,
      bondId,
      "data_query",
      { query: "will_fail" },
      5,
    );
    const actionId = actionData.actionId as string;

    // Resolve as failed — this should trigger a slash/penalty
    await resolveAction(resolver.keys, resolver.identityId, actionId, "failed");

    const repMid = await getReputation(targetUrl, identity.identityId);

    // Step 2: Attempt to continue operating after the slash
    let canContinue = false;
    try {
      const bondData2 = await postBond(identity.keys, identity.identityId, 10, 60, "Post-slash recovery attempt");
      const bondId2 = bondData2.bondId as string;

      const actionData2 = await executeBondedAction(
        identity.keys,
        identity.identityId,
        bondId2,
        "data_query",
        { query: "post_slash_test" },
        5,
      );
      const actionId2 = actionData2.actionId as string;
      await resolveAction(resolver.keys, resolver.identityId, actionId2, "success");
      canContinue = true;
    } catch {
      canContinue = false;
    }

    const repAfter = await getReputation(targetUrl, identity.identityId);

    return {
      actionName: "postSlashRecovery",
      caught: !canContinue,
      details: canContinue
        ? `Identity continued operating after slash. Rep: ${repBefore} → ${repMid} (post-slash) → ${repAfter}. Reputation may provide resilience.`
        : `Identity blocked after slash. Rep: ${repBefore} → ${repMid} (post-slash) → ${repAfter}. No reputation resilience detected.`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  } catch (err) {
    const repAfter = await getReputation(targetUrl, identity.identityId);
    return {
      actionName: "postSlashRecovery",
      caught: true,
      details: `Slash recovery test failed: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: repBefore,
      reputationAfter: repAfter,
    };
  }
}
