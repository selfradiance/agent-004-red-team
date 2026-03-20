// Tests for the strategist module — fallback, library menu, parsing, and live API integration

import "dotenv/config";
import { describe, it, expect } from "vitest";
import {
  getDefaultAttacks,
  buildLibraryMenu,
  pickAttacks,
  parseTeamStrategyResponse,
  getDefaultTeamAttacks,
  type TeamStrategyResponse,
} from "../src/strategist";
import { SHADOW, WHALE, CHAOS, type PersonaIdentity } from "../src/personas";

// Mock team for unit tests
const mockTeam: PersonaIdentity[] = [
  { config: SHADOW, keys: { publicKey: "pub-s", privateKey: "priv-s" }, identityId: "id-shadow" },
  { config: WHALE, keys: { publicKey: "pub-w", privateKey: "priv-w" }, identityId: "id-whale" },
  { config: CHAOS, keys: { publicKey: "pub-c", privateKey: "priv-c" }, identityId: "id-chaos" },
];

describe("strategist — unit tests (single-identity)", () => {
  it("getDefaultAttacks returns correct fallback", () => {
    const mockLibrary = [
      { id: "1.1", name: "Test A", category: "Cat1", defenseTargeted: "D1", parameterizable: false, priority: "Baseline" },
      { id: "2.5", name: "Test B", category: "Cat2", defenseTargeted: "D2", parameterizable: true, priority: "High" },
      { id: "7.1", name: "Test C", category: "Cat3", defenseTargeted: "D3", parameterizable: true, priority: "High" },
      { id: "7.2", name: "Test D", category: "Cat3", defenseTargeted: "D4", parameterizable: true, priority: "High" },
      { id: "3.2", name: "Test E", category: "Cat4", defenseTargeted: "D5", parameterizable: true, priority: "Medium" },
      { id: "9.2", name: "Test F", category: "Cat5", defenseTargeted: "D6", parameterizable: true, priority: "High" },
    ];

    const result = getDefaultAttacks(mockLibrary, 1);

    expect(result.usedFallback).toBe(true);
    expect(result.round).toBe(1);
    expect(result.strategy).toContain("Fallback");
    expect(result.attacks).toHaveLength(4);
    expect(result.attacks.every((a) => a.reasoning.includes("Fallback"))).toBe(true);
    const ids = result.attacks.map((a) => a.id);
    expect(ids).not.toContain("1.1");
    expect(ids).not.toContain("3.2");
    expect(ids).toContain("2.5");
    expect(ids).toContain("7.1");
  });

  it("buildLibraryMenu transforms registry metadata", () => {
    const menu = buildLibraryMenu();

    expect(menu.length).toBe(48);

    for (const entry of menu) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.defenseTargeted).toBe("string");
      expect(typeof entry.parameterizable).toBe("boolean");
      expect(["Baseline", "Medium", "High"]).toContain(entry.priority);
    }

    const replay11 = menu.find((e) => e.id === "1.1");
    expect(replay11).toBeDefined();
    expect(replay11!.name).toBe("Exact duplicate request");
    expect(replay11!.category).toBe("Replay Attacks");
    expect(replay11!.priority).toBe("Baseline");
  });
});

describe("strategist — unit tests (team mode)", () => {
  it("parseTeamStrategyResponse parses valid team response", () => {
    const json = JSON.stringify({
      round: 1,
      strategy: "Test strategy",
      assignments: [
        {
          persona: "shadow",
          attacks: [{ id: "1.1", reasoning: "Recon probe" }],
        },
        {
          persona: "whale",
          attacks: [{ id: "2.1", params: { bond_amount: 200 }, reasoning: "Economic test" }],
        },
        {
          persona: "chaos",
          attacks: [{ id: "5.1", reasoning: "Fuzzing" }],
        },
      ],
      coordinated_ops: [
        {
          type: "handoff",
          personas: ["shadow", "whale"],
          attack_refs: ["6.1", "6.1"],
          target_defense: "Per-identity rate limiting",
          expected_signal: "Enforcement inconsistency under cross-identity load",
          why_multi_identity: "Rate limit is per-identity — need two identities to test cross-identity behavior",
          intel_from: "shadow",
          intel_summary: "Rate limit triggers at 10 requests per 60s",
        },
      ],
    });

    const result = parseTeamStrategyResponse(json);

    expect(result.round).toBe(1);
    expect(result.strategy).toBe("Test strategy");
    expect(result.assignments).toHaveLength(3);
    expect(result.assignments[0].persona).toBe("shadow");
    expect(result.assignments[0].attacks).toHaveLength(1);
    expect(result.assignments[1].persona).toBe("whale");
    expect(result.assignments[1].attacks[0].params).toEqual({ bond_amount: 200 });
    expect(result.assignments[2].persona).toBe("chaos");
    expect(result.coordinatedOps).toHaveLength(1);
    expect(result.coordinatedOps[0].type).toBe("handoff");
    expect(result.coordinatedOps[0].personas).toEqual(["shadow", "whale"]);
    expect(result.coordinatedOps[0].targetDefense).toBe("Per-identity rate limiting");
    expect(result.coordinatedOps[0].intelFrom).toBe("shadow");
    expect(result.coordinatedOps[0].intelSummary).toContain("10 requests");
  });

  it("parseTeamStrategyResponse handles response with no coordinated ops", () => {
    const json = JSON.stringify({
      round: 1,
      strategy: "Independent probing only",
      assignments: [
        { persona: "shadow", attacks: [{ id: "12.1", reasoning: "Recon" }] },
      ],
      coordinated_ops: [],
    });

    const result = parseTeamStrategyResponse(json);
    expect(result.coordinatedOps).toHaveLength(0);
    expect(result.assignments).toHaveLength(1);
  });

  it("parseTeamStrategyResponse handles missing coordinated_ops field", () => {
    const json = JSON.stringify({
      round: 1,
      strategy: "No ops field",
      assignments: [
        { persona: "chaos", attacks: [{ id: "8.1", reasoning: "Protocol probe" }] },
      ],
    });

    const result = parseTeamStrategyResponse(json);
    expect(result.coordinatedOps).toHaveLength(0);
  });

  it("parseTeamStrategyResponse strips markdown fences", () => {
    const json = JSON.stringify({
      round: 2,
      strategy: "Fenced response",
      assignments: [],
      coordinated_ops: [],
    });
    const wrapped = "```json\n" + json + "\n```";

    const result = parseTeamStrategyResponse(wrapped);
    expect(result.round).toBe(2);
    expect(result.strategy).toBe("Fenced response");
  });

  it("parseTeamStrategyResponse rejects invalid JSON", () => {
    expect(() => parseTeamStrategyResponse("not json at all")).toThrow("invalid JSON");
  });

  it("getDefaultTeamAttacks returns persona-specific fallbacks", () => {
    const library = buildLibraryMenu();
    const result = getDefaultTeamAttacks(library, 1, mockTeam);

    expect(result.usedFallback).toBe(true);
    expect(result.round).toBe(1);
    expect(result.assignments).toHaveLength(3);
    expect(result.coordinatedOps).toHaveLength(0);

    // Each assignment should be for a different persona
    const personaNames = result.assignments.map((a) => a.persona);
    expect(personaNames).toContain("shadow");
    expect(personaNames).toContain("whale");
    expect(personaNames).toContain("chaos");

    // Each persona should get attacks from their specialty categories
    for (const assignment of result.assignments) {
      expect(assignment.attacks.length).toBeGreaterThan(0);
      expect(assignment.attacks.length).toBeLessThanOrEqual(3);
    }
  });
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("your-"))(
  "strategist — live Claude API",
  () => {
    it("pickAttacks returns valid strategy for round 1", { timeout: 30000 }, async () => {
      const library = buildLibraryMenu();
      const result = await pickAttacks(library, 1, 3, []);

      expect(result.round).toBe(1);
      expect(typeof result.strategy).toBe("string");
      expect(result.strategy.length).toBeGreaterThan(0);
      expect(result.attacks.length).toBeGreaterThanOrEqual(5);
      expect(result.attacks.length).toBeLessThanOrEqual(15);

      for (const pick of result.attacks) {
        expect(typeof pick.id).toBe("string");
        expect(typeof pick.reasoning).toBe("string");
      }

      const libraryIds = new Set(library.map((e) => e.id));
      for (const pick of result.attacks) {
        expect(libraryIds.has(pick.id)).toBe(true);
      }
    });
  },
);
