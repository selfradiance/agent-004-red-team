// Tests for Beta Strategist (Stage 5)

import { describe, it, expect } from "vitest";
import { getSwarmConfig } from "../src/swarm";
import type { BetaStrategistConfig, ReputationSnapshot } from "../src/beta-strategist";
import {
  buildBetaSystemPrompt,
  buildBetaUserMessage,
  parseBetaStrategyResponse,
  getDefaultBetaActions,
  getBetaPhase,
  getBetaMidpoint,
} from "../src/beta-strategist";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const swarmConfig = getSwarmConfig();
const betaTeam = swarmConfig.teams[1]; // beta

function makeConfig(overrides: Partial<BetaStrategistConfig> = {}): BetaStrategistConfig {
  return {
    team: betaTeam,
    currentRound: 1,
    totalRounds: 5,
    sharedIntel: "No prior intelligence available.",
    reputationData: [],
    priorBetaResults: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase calculation
// ---------------------------------------------------------------------------

describe("beta-strategist — phase calculation", () => {
  it("midpoint of 5 rounds is 3", () => {
    expect(getBetaMidpoint(5)).toBe(3);
  });

  it("midpoint of 4 rounds is 2", () => {
    expect(getBetaMidpoint(4)).toBe(2);
  });

  it("midpoint of 1 round is 1", () => {
    expect(getBetaMidpoint(1)).toBe(1);
  });

  it("midpoint of 6 rounds is 3", () => {
    expect(getBetaMidpoint(6)).toBe(3);
  });

  it("midpoint of 10 rounds is 5", () => {
    expect(getBetaMidpoint(10)).toBe(5);
  });

  it("rounds 1-3 of 5 are trust-building", () => {
    expect(getBetaPhase(1, 5)).toBe("trust-building");
    expect(getBetaPhase(2, 5)).toBe("trust-building");
    expect(getBetaPhase(3, 5)).toBe("trust-building");
  });

  it("rounds 4-5 of 5 are offensive", () => {
    expect(getBetaPhase(4, 5)).toBe("offensive");
    expect(getBetaPhase(5, 5)).toBe("offensive");
  });

  it("single round is trust-building", () => {
    expect(getBetaPhase(1, 1)).toBe("trust-building");
  });
});

// ---------------------------------------------------------------------------
// System prompt — early rounds (trust building)
// ---------------------------------------------------------------------------

describe("beta-strategist — early round prompt", () => {
  it("emphasizes trust building", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 1, totalRounds: 5 }));
    expect(prompt).toContain("TRUST-BUILDING");
    expect(prompt).toContain("Do NOT attack yet");
  });

  it("includes trust-building actions", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 1, totalRounds: 5 }));
    expect(prompt).toContain("cleanBondCycle");
    expect(prompt).toContain("multipleCleanCycles");
    expect(prompt).toContain("checkReputation");
  });

  it("does NOT include offensive actions in early rounds", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 1, totalRounds: 5 }));
    expect(prompt).not.toContain("highValueBondAttempt");
    expect(prompt).not.toContain("rapidExecutionBurst");
    expect(prompt).not.toContain("postSlashRecovery");
  });

  it("includes team info", () => {
    const prompt = buildBetaSystemPrompt(makeConfig());
    expect(prompt).toContain("beta");
    expect(prompt).toContain("beta-1");
    expect(prompt).toContain("beta-2");
    expect(prompt).toContain("beta-3");
  });
});

// ---------------------------------------------------------------------------
// System prompt — late rounds (offensive)
// ---------------------------------------------------------------------------

describe("beta-strategist — late round prompt", () => {
  it("emphasizes offensive trust spending", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 4, totalRounds: 5 }));
    expect(prompt).toContain("OFFENSIVE TRUST-SPENDING");
    expect(prompt).toContain("accumulated reputation");
  });

  it("includes offensive actions", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 4, totalRounds: 5 }));
    expect(prompt).toContain("rapidExecutionBurst");
    expect(prompt).toContain("resolveOtherIdentityAction");
    expect(prompt).toContain("postSlashRecovery");
    expect(prompt).not.toContain("highValueBondAttempt");
  });

  it("does NOT include trust-building actions in late rounds", () => {
    const prompt = buildBetaSystemPrompt(makeConfig({ currentRound: 4, totalRounds: 5 }));
    expect(prompt).not.toContain("cleanBondCycle");
    expect(prompt).not.toContain("multipleCleanCycles");
  });
});

// ---------------------------------------------------------------------------
// User message — reputation snapshot
// ---------------------------------------------------------------------------

describe("beta-strategist — user message", () => {
  it("includes reputation data in late-round prompts", () => {
    const config = makeConfig({
      currentRound: 4,
      totalRounds: 5,
      reputationData: [
        { agentId: "beta-1", reputation: 85 },
        { agentId: "beta-2", reputation: 72 },
        { agentId: "beta-3", reputation: null },
      ],
    });
    const msg = buildBetaUserMessage(config);
    expect(msg).toContain("CURRENT REPUTATION");
    expect(msg).toContain("beta-1: 85");
    expect(msg).toContain("beta-2: 72");
    expect(msg).toContain("beta-3: unknown");
  });

  it("includes prior Beta results", () => {
    const config = makeConfig({
      priorBetaResults: [
        "[R1] beta-1: cleanBondCycle — OK: completed",
        "[R2] beta-2: multipleCleanCycles — OK: 3 cycles",
      ],
    });
    const msg = buildBetaUserMessage(config);
    expect(msg).toContain("PRIOR BETA RESULTS");
    expect(msg).toContain("cleanBondCycle");
    expect(msg).toContain("multipleCleanCycles");
  });

  it("includes shared intel when available", () => {
    const config = makeConfig({
      sharedIntel: "=== SHARED INTELLIGENCE LOG ===\n[alpha] found open endpoint",
    });
    const msg = buildBetaUserMessage(config);
    expect(msg).toContain("SHARED INTELLIGENCE");
    expect(msg).toContain("found open endpoint");
  });

  it("round context is included", () => {
    const config = makeConfig({ currentRound: 3, totalRounds: 7 });
    const msg = buildBetaUserMessage(config);
    expect(msg).toContain("round 3 of 7");
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe("beta-strategist — parseBetaStrategyResponse", () => {
  it("parses valid response", () => {
    const json = JSON.stringify({
      round: 1,
      strategy: "Build trust across all agents",
      selectedActions: [
        { actionName: "cleanBondCycle", agentId: "beta-1", reasoning: "Start building reputation" },
        { actionName: "multipleCleanCycles", agentId: "beta-2", reasoning: "Fast reputation building", params: { count: 5 } },
      ],
    });

    const config = makeConfig({ currentRound: 1, totalRounds: 5 });
    const result = parseBetaStrategyResponse(json, config);

    expect(result.phase).toBe("trust-building");
    expect(result.round).toBe(1);
    expect(result.selectedActions).toHaveLength(2);
    expect(result.selectedActions[0].actionName).toBe("cleanBondCycle");
    expect(result.selectedActions[1].params).toEqual({ count: 5 });
  });

  it("throws on invalid JSON", () => {
    const config = makeConfig();
    expect(() => parseBetaStrategyResponse("not json", config)).toThrow("invalid JSON");
  });

  it("throws on missing selectedActions", () => {
    const config = makeConfig();
    expect(() => parseBetaStrategyResponse(JSON.stringify({ strategy: "test" }), config)).toThrow("missing 'selectedActions'");
  });

  it("caps selected actions at 6 and filters invalid phase actions", () => {
    const json = JSON.stringify({
      round: 1,
      strategy: "Build trust safely",
      selectedActions: [
        { actionName: "cleanBondCycle", agentId: "beta-1", reasoning: "1" },
        { actionName: "multipleCleanCycles", agentId: "beta-2", reasoning: "2" },
        { actionName: "checkReputation", agentId: "beta-3", reasoning: "3" },
        { actionName: "rapidExecutionBurst", agentId: "beta-1", reasoning: "invalid for trust phase" },
        { actionName: "cleanBondCycle", agentId: "beta-1", reasoning: "4" },
        { actionName: "cleanBondCycle", agentId: "beta-2", reasoning: "5" },
        { actionName: "cleanBondCycle", agentId: "beta-3", reasoning: "6" },
        { actionName: "cleanBondCycle", agentId: "beta-1", reasoning: "7" },
      ],
    });

    const result = parseBetaStrategyResponse(json, makeConfig({ currentRound: 1, totalRounds: 5 }));

    expect(result.selectedActions).toHaveLength(6);
    expect(result.selectedActions.every((action) => action.actionName !== "rapidExecutionBurst")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe("beta-strategist — fallback", () => {
  it("early round fallback returns trust-building actions", () => {
    const config = makeConfig({ currentRound: 1, totalRounds: 5 });
    const result = getDefaultBetaActions(config);

    expect(result.phase).toBe("trust-building");
    expect(result.usedFallback).toBe(true);
    expect(result.selectedActions).toHaveLength(3);
    for (const action of result.selectedActions) {
      expect(action.actionName).toBe("multipleCleanCycles");
    }
  });

  it("late round fallback returns offensive actions", () => {
    const config = makeConfig({ currentRound: 4, totalRounds: 5 });
    const result = getDefaultBetaActions(config);

    expect(result.phase).toBe("offensive");
    expect(result.usedFallback).toBe(true);
    expect(result.selectedActions).toHaveLength(3);
    expect(result.selectedActions[0].actionName).toBe("rapidExecutionBurst");
    expect(result.selectedActions[1].actionName).toBe("resolveOtherIdentityAction");
    expect(result.selectedActions[2].actionName).toBe("postSlashRecovery");
  });

  it("fallback distributes across all three agents", () => {
    const config = makeConfig({ currentRound: 1, totalRounds: 5 });
    const result = getDefaultBetaActions(config);

    const agentIds = result.selectedActions.map((a) => a.agentId);
    expect(agentIds).toContain("beta-1");
    expect(agentIds).toContain("beta-2");
    expect(agentIds).toContain("beta-3");
  });

  it("fallback includes reputation snapshot", () => {
    const repData: ReputationSnapshot[] = [
      { agentId: "beta-1", reputation: 50 },
    ];
    const config = makeConfig({ reputationData: repData });
    const result = getDefaultBetaActions(config);
    expect(result.reputationSnapshot).toEqual(repData);
  });
});
