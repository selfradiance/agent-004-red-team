// Runs attack scenarios against a live AgentGate instance — supports both
// static (all attacks in order) and adaptive (strategist-selected) modes

import type { AttackResult } from "./log";
import type { AttackClient } from "./attacks/replay";
import type { AttackPick } from "./strategist";
import { getAllScenarios, getScenario } from "./registry";

// ---------------------------------------------------------------------------
// Numeric-aware sort for scenario IDs like "1.1", "2.3", "10.1"
// ---------------------------------------------------------------------------

function sortScenarioIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const [aCat, aNum] = a.split(".").map(Number);
    const [bCat, bNum] = b.split(".").map(Number);
    if (aCat !== bCat) return aCat - bCat;
    return aNum - bNum;
  });
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

export function printRoundHeader(round: number, totalRounds: number, strategy: string): void {
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`  ROUND ${round} of ${totalRounds}`);
  console.log(`  Strategy: ${strategy}`);
  console.log("═══════════════════════════════════════════");
  console.log("");
}

export function printRoundSummary(round: number, results: AttackResult[]): void {
  const caught = results.filter((r) => r.caught).length;
  const uncaught = results.filter((r) => !r.caught).length;
  console.log("");
  console.log("───────────────────────────────────────────");
  console.log(`  Round ${round} complete: ${results.length} attacks, ${caught} caught, ${uncaught} uncaught`);
  console.log("───────────────────────────────────────────");
}

// ---------------------------------------------------------------------------
// Mode 1: Run specific attacks by ID (for adaptive rounds)
// ---------------------------------------------------------------------------

export async function runSelectedAttacks(
  picks: AttackPick[],
  client: AttackClient,
  round: number,
): Promise<AttackResult[]> {
  const results: AttackResult[] = [];

  for (const pick of picks) {
    const entry = getScenario(pick.id);

    if (!entry) {
      const result: AttackResult = {
        scenarioId: pick.id,
        scenarioName: "UNKNOWN",
        category: "UNKNOWN",
        expectedOutcome: "N/A",
        actualOutcome: "UNKNOWN — scenario ID not found in registry",
        caught: false,
        details: `Scenario ${pick.id} not found in registry. The strategist may have returned an invalid ID.`,
      };
      results.push(result);
      console.log(`  [${pick.id}] UNKNOWN — NOT FOUND in registry`);
      continue;
    }

    try {
      const result = await (entry.execute as (client: AttackClient, params?: Record<string, unknown>) => Promise<AttackResult>)(client, pick.params);
      results.push(result);

      const status = result.caught ? "CAUGHT" : "UNCAUGHT ⚠️";
      console.log(`  [${pick.id}] ${entry.name} → ${status}`);
    } catch (err) {
      const result: AttackResult = {
        scenarioId: pick.id,
        scenarioName: entry.name,
        category: entry.category,
        expectedOutcome: entry.description,
        actualOutcome: `Error: ${err instanceof Error ? err.message : String(err)}`,
        caught: false,
        details: `Attack threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      };
      results.push(result);
      console.log(`  [${pick.id}] ${entry.name} → [ERROR] ${result.actualOutcome}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mode 2: Run all attacks in fixed order (for --static mode)
// ---------------------------------------------------------------------------

export async function runAllAttacksStatic(client: AttackClient): Promise<AttackResult[]> {
  const scenarios = getAllScenarios();
  const sortedIds = sortScenarioIds(scenarios.map((s) => s.id));

  const results: AttackResult[] = [];

  for (const id of sortedIds) {
    const entry = getScenario(id)!;
    console.log(`Running attack [${id}]: ${entry.name}...`);

    try {
      const result = await (entry.execute as (client: AttackClient, params?: Record<string, unknown>) => Promise<AttackResult>)(client);
      results.push(result);

      if (result.caught) {
        console.log("  → [CAUGHT]");
      } else {
        console.log("  → [UNCAUGHT] ⚠️");
      }
    } catch (err) {
      const result: AttackResult = {
        scenarioId: id,
        scenarioName: entry.name,
        category: entry.category,
        expectedOutcome: entry.description,
        actualOutcome: `Error: ${err instanceof Error ? err.message : String(err)}`,
        caught: false,
        details: `Attack threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      };
      results.push(result);
      console.log(`  → [ERROR] ${result.actualOutcome}`);
    }
  }

  return results;
}
