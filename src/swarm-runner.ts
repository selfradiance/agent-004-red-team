// Interleaved campaign runner for Stage 5 swarm mode. Orchestrates
// multi-round campaigns with three teams of three agents each, using
// coordinator synthesis and per-team strategists between rounds.
// Does NOT replace runner.ts — that file still handles --static and --team modes.

import type { AttackResult } from "./log";
import type { AttackClient } from "./attacks/replay";
import type { SwarmConfig, SwarmTeamName, SwarmAgentIdentity } from "./swarm";
import type { SwarmStrategistConfig, SwarmAttackPick } from "./swarm-strategist";
import type { CoordinatorConfig, RoundResultEntry } from "./coordinator";
import type { LibraryEntry } from "./strategist";
import { IntelLog } from "./intel-log";
import { getScenario } from "./registry";
import { buildLibraryMenu } from "./strategist";
import { pickSwarmAttacks, submitTeamQuestions, getDefaultSwarmAttacks } from "./swarm-strategist";
import { synthesizeIntelligence } from "./coordinator";
import { pickBetaActions, getBetaPhase, isActionValidForPhase, type BetaStrategistConfig, type ReputationSnapshot, type BetaActionPick } from "./beta-strategist";
import { cleanBondCycle, multipleCleanCycles, checkReputation, highValueBondAttempt, rapidExecutionBurst, resolveOtherIdentityAction, postSlashRecovery, type BetaIdentity, type BetaTaskResult } from "./beta-tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmCampaignConfig {
  swarmConfig: SwarmConfig;
  identities: Map<string, SwarmAgentIdentity>;
  targetUrl: string;
  totalRounds: number;
  sequential: boolean;
}

export interface SwarmAttackResult extends AttackResult {
  teamName: SwarmTeamName;
  agentId: string;
  roundNumber: number;
  executionPosition: number;
}

export interface SwarmRoundResult {
  roundNumber: number;
  teamResults: Map<SwarmTeamName, SwarmAttackResult[]>;
  coordinatorSynthesis: boolean;
}

export interface TeamSummary {
  attacks: number;
  caught: number;
  uncaught: number;
}

export interface SwarmCampaignResult {
  rounds: SwarmRoundResult[];
  intelLog: IntelLog;
  plannedRounds: number;
  completedRounds: number;
  interrupted: boolean;
  interruptionReason?: string;
  totalAttacks: number;
  totalCaught: number;
  totalUncaught: number;
  perTeamSummary: Map<SwarmTeamName, TeamSummary>;
}

export interface QueuedAttack {
  pick: SwarmAttackPick;
  teamName: SwarmTeamName;
  agentId: string;
}

// ---------------------------------------------------------------------------
// Interleave helper
// ---------------------------------------------------------------------------

/**
 * Deterministic round-robin interleave across teams.
 * If teams have unequal counts, remaining attacks from longer lists go at the end.
 */
export function interleaveAttacks(teamAttacks: Map<string, QueuedAttack[]>): QueuedAttack[] {
  const teams = [...teamAttacks.keys()].sort();
  const queues = teams.map((t) => [...(teamAttacks.get(t) ?? [])]);
  const result: QueuedAttack[] = [];

  const maxLen = Math.max(...queues.map((q) => q.length), 0);

  for (let i = 0; i < maxLen; i++) {
    for (const queue of queues) {
      if (i < queue.length) {
        result.push(queue[i]);
      }
    }
  }

  return result;
}

/**
 * Sequential ordering: all Alpha attacks, then Beta, then Gamma.
 */
export function sequentialAttacks(teamAttacks: Map<string, QueuedAttack[]>): QueuedAttack[] {
  const teams = [...teamAttacks.keys()].sort();
  const result: QueuedAttack[] = [];
  for (const team of teams) {
    result.push(...(teamAttacks.get(team) ?? []));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build AttackClient from swarm identity
// ---------------------------------------------------------------------------

function identityToClient(identity: SwarmAgentIdentity, targetUrl: string, apiKey: string): AttackClient {
  return {
    agentGateUrl: targetUrl,
    apiKey,
    keys: identity.keys,
    identityId: identity.identityId,
  };
}

// ---------------------------------------------------------------------------
// Execute a single queued attack
// ---------------------------------------------------------------------------

async function executeQueuedAttack(
  attack: QueuedAttack,
  position: number,
  roundNumber: number,
  identities: Map<string, SwarmAgentIdentity>,
  targetUrl: string,
  apiKey: string,
): Promise<SwarmAttackResult> {
  const identity = identities.get(attack.agentId);

  if (!identity) {
    console.log(`  [${attack.teamName}/${attack.agentId}] [${attack.pick.id}] SKIPPED — identity not found`);
    return {
      scenarioId: attack.pick.id,
      scenarioName: "UNKNOWN",
      category: "UNKNOWN",
      expectedOutcome: "N/A",
      actualOutcome: `Identity ${attack.agentId} not found`,
      caught: false,
      details: `Agent identity ${attack.agentId} not found in loaded identities.`,
      teamName: attack.teamName,
      agentId: attack.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  // Guard: ensure the identity belongs to the team claiming it
  if (identity.config.team !== attack.teamName) {
    console.log(`  [${attack.teamName}/${attack.agentId}] [${attack.pick.id}] SKIPPED — cross-team identity mismatch`);
    return {
      scenarioId: attack.pick.id,
      scenarioName: "UNKNOWN",
      category: "UNKNOWN",
      expectedOutcome: "N/A",
      actualOutcome: `Agent ${attack.agentId} belongs to team ${identity.config.team}, not ${attack.teamName}`,
      caught: false,
      details: `Cross-team identity mismatch: ${attack.agentId} is ${identity.config.team}, attack queued for ${attack.teamName}.`,
      teamName: attack.teamName,
      agentId: attack.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  const entry = getScenario(attack.pick.id);

  if (!entry) {
    console.log(`  [${attack.teamName}/${attack.agentId}] [${attack.pick.id}] NOT FOUND in registry`);
    return {
      scenarioId: attack.pick.id,
      scenarioName: "UNKNOWN",
      category: "UNKNOWN",
      expectedOutcome: "N/A",
      actualOutcome: `Scenario ${attack.pick.id} not found in registry`,
      caught: false,
      details: `Scenario ${attack.pick.id} not found in registry.`,
      teamName: attack.teamName,
      agentId: attack.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  console.log(`  [Round ${roundNumber}] [${attack.teamName}/${attack.agentId}] Running attack ${attack.pick.id}: ${entry.name}...`);

  try {
    const client = identityToClient(identity, targetUrl, apiKey);
    const result = await (entry.execute as (client: AttackClient, params?: Record<string, unknown>) => Promise<AttackResult>)(client, attack.pick.params);

    const status = result.caught ? "CAUGHT" : "UNCAUGHT";
    console.log(`    → ${status}`);

    return {
      ...result,
      teamName: attack.teamName,
      agentId: attack.agentId,
      roundNumber,
      executionPosition: position,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`    → [ERROR] ${errorMsg}`);

    return {
      scenarioId: attack.pick.id,
      scenarioName: entry.name,
      category: entry.category,
      expectedOutcome: entry.description,
      actualOutcome: `Error: ${errorMsg}`,
      caught: false,
      details: `Attack threw an unexpected error: ${errorMsg}`,
      teamName: attack.teamName,
      agentId: attack.agentId,
      roundNumber,
      executionPosition: position,
    };
  }
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

export function printCampaignBanner(config: SwarmCampaignConfig): void {
  const { swarmConfig, totalRounds, sequential } = config;
  const mode = sequential ? "sequential" : "interleaved";

  console.log("");
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║          SWARM CAMPAIGN — v0.5.0-alpha        ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Teams: ${swarmConfig.teams.length}`);
  console.log(`  Agents per team: ${swarmConfig.teams[0].agents.length}`);
  console.log(`  Total rounds: ${totalRounds}`);
  console.log(`  Execution mode: ${mode}`);
  console.log(`  Campaign budget cap: ${swarmConfig.campaignCapCents}¢`);
  console.log("");

  for (const team of swarmConfig.teams) {
    console.log(`  Team ${team.name.toUpperCase()}: ${team.objective}`);
    console.log(`    Budget: ${team.teamBudgetCents}¢ (${team.agents[0].bondBudgetCents}¢/agent)`);
  }

  console.log("");
}

export function printSwarmRoundSummary(roundNumber: number, results: SwarmAttackResult[]): void {
  console.log("");
  console.log("───────────────────────────────────────────");
  console.log(`  Round ${roundNumber} Summary`);
  console.log("───────────────────────────────────────────");

  const teams = new Set(results.map((r) => r.teamName));
  for (const team of [...teams].sort()) {
    const teamResults = results.filter((r) => r.teamName === team);
    const caught = teamResults.filter((r) => r.caught).length;
    const uncaught = teamResults.length - caught;
    console.log(`  ${team}: ${teamResults.length} attacks, ${caught} caught, ${uncaught} uncaught`);
  }

  const totalCaught = results.filter((r) => r.caught).length;
  console.log(`  TOTAL: ${results.length} attacks, ${totalCaught} caught, ${results.length - totalCaught} uncaught`);
  console.log("───────────────────────────────────────────");
}

// ---------------------------------------------------------------------------
// Aggregate campaign results
// ---------------------------------------------------------------------------

export function aggregateCampaignResults(
  rounds: SwarmRoundResult[],
  intelLog: IntelLog,
  options?: {
    plannedRounds?: number;
    interrupted?: boolean;
    interruptionReason?: string;
  },
): SwarmCampaignResult {
  const perTeamSummary = new Map<SwarmTeamName, TeamSummary>();
  let totalAttacks = 0;
  let totalCaught = 0;
  let totalUncaught = 0;

  for (const round of rounds) {
    for (const [teamName, results] of round.teamResults) {
      const existing = perTeamSummary.get(teamName) ?? { attacks: 0, caught: 0, uncaught: 0 };
      for (const r of results) {
        existing.attacks++;
        totalAttacks++;
        if (r.caught) {
          existing.caught++;
          totalCaught++;
        } else {
          existing.uncaught++;
          totalUncaught++;
        }
      }
      perTeamSummary.set(teamName, existing);
    }
  }

  return {
    rounds,
    intelLog,
    plannedRounds: options?.plannedRounds ?? rounds.length,
    completedRounds: rounds.length,
    interrupted: options?.interrupted ?? false,
    interruptionReason: options?.interruptionReason,
    totalAttacks,
    totalCaught,
    totalUncaught,
    perTeamSummary,
  };
}

// ---------------------------------------------------------------------------
// Validate config
// ---------------------------------------------------------------------------

export function validateCampaignConfig(config: SwarmCampaignConfig): string[] {
  const errors: string[] = [];

  if (!config.swarmConfig) errors.push("swarmConfig is required");
  if (!config.identities || config.identities.size === 0) errors.push("identities map is required and must not be empty");
  if (!config.targetUrl) errors.push("targetUrl is required");
  if (config.totalRounds < 1) errors.push("totalRounds must be at least 1");

  if (config.swarmConfig?.teams) {
    for (const team of config.swarmConfig.teams) {
      for (const agent of team.agents) {
        if (!config.identities?.has(agent.agentId)) {
          errors.push(`Missing identity for agent ${agent.agentId}`);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Beta task execution helper
// ---------------------------------------------------------------------------

function betaIdentityFromSwarm(identity: SwarmAgentIdentity): BetaIdentity {
  return {
    keys: identity.keys,
    identityId: identity.identityId,
    agentId: identity.config.agentId,
  };
}

/**
 * Pick a resolver identity for a Beta agent. AgentGate requires a different
 * identity to resolve an action (dual-control). We pick the first Beta
 * teammate that isn't the executor.
 */
function pickBetaResolver(executorAgentId: string, identities: Map<string, SwarmAgentIdentity>): BetaIdentity | null {
  const betaAgents = ["beta-1", "beta-2", "beta-3"];
  for (const agentId of betaAgents) {
    if (agentId !== executorAgentId) {
      const identity = identities.get(agentId);
      if (identity) return betaIdentityFromSwarm(identity);
    }
  }
  return null;
}

async function executeBetaAction(
  pick: BetaActionPick,
  roundNumber: number,
  totalRounds: number,
  position: number,
  identities: Map<string, SwarmAgentIdentity>,
  targetUrl: string,
): Promise<SwarmAttackResult> {
  // Phase enforcement: reject actions that don't belong to the current phase
  const phase = getBetaPhase(roundNumber, totalRounds);
  if (!isActionValidForPhase(pick.actionName, phase)) {
    console.log(`  [Round ${roundNumber}] [beta/${pick.agentId}] REJECTED ${pick.actionName} — not valid for ${phase} phase`);
    return {
      scenarioId: `beta:${pick.actionName}`,
      scenarioName: pick.actionName,
      category: "Beta Trust",
      expectedOutcome: "N/A",
      actualOutcome: `Action ${pick.actionName} rejected: not valid for ${phase} phase`,
      caught: true,
      details: `Phase enforcement: ${pick.actionName} is not allowed during ${phase} phase (round ${roundNumber}/${totalRounds}).`,
      teamName: "beta",
      agentId: pick.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  const identity = identities.get(pick.agentId);
  if (!identity) {
    return {
      scenarioId: `beta:${pick.actionName}`,
      scenarioName: pick.actionName,
      category: "Beta Trust",
      expectedOutcome: "N/A",
      actualOutcome: `Identity ${pick.agentId} not found`,
      caught: false,
      details: `Agent identity ${pick.agentId} not found.`,
      teamName: "beta",
      agentId: pick.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  const betaId = betaIdentityFromSwarm(identity);
  const resolver = pickBetaResolver(pick.agentId, identities);
  console.log(`  [Round ${roundNumber}] [beta/${pick.agentId}] Running ${pick.actionName}...`);

  if (!resolver) {
    return {
      scenarioId: `beta:${pick.actionName}`,
      scenarioName: pick.actionName,
      category: "Beta Trust",
      expectedOutcome: "N/A",
      actualOutcome: "No resolver identity available",
      caught: true,
      details: "No Beta teammate available to act as resolver (dual-control requires separate identity).",
      teamName: "beta",
      agentId: pick.agentId,
      roundNumber,
      executionPosition: position,
    };
  }

  let result: BetaTaskResult;

  try {
    switch (pick.actionName) {
      case "cleanBondCycle":
        result = await cleanBondCycle(betaId, resolver, targetUrl);
        break;
      case "multipleCleanCycles": {
        const count = (pick.params?.count as number) ?? 3;
        result = await multipleCleanCycles(betaId, resolver, targetUrl, count);
        break;
      }
      case "checkReputation":
        result = await checkReputation(betaId, targetUrl);
        break;
      case "highValueBondAttempt":
        result = await highValueBondAttempt(betaId, targetUrl);
        break;
      case "rapidExecutionBurst":
        result = await rapidExecutionBurst(betaId, resolver, targetUrl);
        break;
      case "resolveOtherIdentityAction": {
        // Use beta-1 as trusted, beta-3 as fresh (or pick.params.freshAgentId)
        const VALID_BETA_IDS = new Set(["beta-1", "beta-2", "beta-3"]);
        const rawFreshId = (pick.params?.freshAgentId as string) ?? "beta-3";
        // Validate freshAgentId belongs to Beta team — prevent cross-team identity leak
        const freshAgentId = VALID_BETA_IDS.has(rawFreshId) ? rawFreshId : "beta-3";
        const freshIdentity = identities.get(freshAgentId);
        if (!freshIdentity) {
          result = { actionName: pick.actionName, caught: true, details: `Fresh identity ${freshAgentId} not found`, reputationBefore: null, reputationAfter: null };
          break;
        }
        result = await resolveOtherIdentityAction(betaId, betaIdentityFromSwarm(freshIdentity), targetUrl);
        break;
      }
      case "postSlashRecovery":
        result = await postSlashRecovery(betaId, resolver, targetUrl);
        break;
      default:
        result = { actionName: pick.actionName, caught: true, details: `Unknown Beta action: ${pick.actionName}`, reputationBefore: null, reputationAfter: null };
    }
  } catch (err) {
    result = {
      actionName: pick.actionName,
      caught: true,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
      reputationBefore: null,
      reputationAfter: null,
    };
  }

  const status = result.caught ? "CAUGHT" : "OK";
  console.log(`    → ${status}: ${result.details.slice(0, 100)}`);

  return {
    scenarioId: `beta:${result.actionName}`,
    scenarioName: result.actionName,
    category: "Beta Trust",
    expectedOutcome: "Trust exploitation test",
    actualOutcome: result.details,
    caught: result.caught,
    details: result.details,
    sideEffects: {
      reputationBefore: result.reputationBefore ?? undefined,
      reputationAfter: result.reputationAfter ?? undefined,
      reputationDelta: result.reputationBefore !== null && result.reputationAfter !== null
        ? result.reputationAfter - result.reputationBefore
        : undefined,
    },
    teamName: "beta",
    agentId: pick.agentId,
    roundNumber,
    executionPosition: position,
  };
}

// ---------------------------------------------------------------------------
// Budget tracker — enforces per-agent and campaign spending caps at runtime
// ---------------------------------------------------------------------------

/**
 * Estimates the bond cost of an attack/action based on its name and params.
 * This is a conservative estimate — actual AgentGate charges may differ,
 * but this prevents runaway spending locally before requests are made.
 */
type CostEstimator = number | ((params?: Record<string, unknown>) => number);

const DEFAULT_REGISTRY_COST_CENTS = 100;

function getNonNegativeIntParam(
  params: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = params?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.ceil(value));
}

const REGISTRY_COST_ESTIMATORS: Record<string, CostEstimator> = {
  "2.4": 0,
  "4.1": 0,
  "4.4": 0,
  "4.5": (params) => 100 * (getNonNegativeIntParam(params, "malicious_count", 3) + 1),
  "5.3": 0,
  "5.4": 0,
  "6.1": (params) => {
    const requestCount = getNonNegativeIntParam(params, "request_count", 11);
    const exposurePerRequest = getNonNegativeIntParam(params, "exposure_per_request", 10);
    return requestCount * exposurePerRequest * 2;
  },
  "6.2": (params) => getNonNegativeIntParam(params, "identity_count", 3) * 1000,
  "6.3": 5000,
  "7.3": 0,
  "9.1": 0,
  "9.2": 0,
  "9.3": 0,
  "10.1": 0,
  "10.2": 0,
  "10.3": (params) => getNonNegativeIntParam(params, "position_count", 20) * 10,
  "10.4": 10,
  "11.1": (params) =>
    (getNonNegativeIntParam(params, "pump_count", 10) * getNonNegativeIntParam(params, "bond_amount_cents", 1)) + 1000,
  "11.2": (params) => getNonNegativeIntParam(params, "identity_count", 5) * 500,
  "11.3": (params) => getNonNegativeIntParam(params, "identity_count", 5) * 100,
  "12.1": 0,
};

function estimateRegistryAttackCost(scenarioId: string, params?: Record<string, unknown>): number {
  const estimator = REGISTRY_COST_ESTIMATORS[scenarioId];
  const estimatedCost = typeof estimator === "function"
    ? estimator(params)
    : estimator ?? DEFAULT_REGISTRY_COST_CENTS;
  return Math.max(0, Math.ceil(estimatedCost));
}

export function estimateActionCost(actionNameOrId: string, params?: Record<string, unknown>): number {
  // Beta trust-building actions
  if (actionNameOrId === "cleanBondCycle") return 10;
  if (actionNameOrId === "multipleCleanCycles") {
    const count = Math.min((params?.count as number) ?? 3, 10);
    return 10 * count; // 10¢ per cycle
  }
  if (actionNameOrId === "checkReputation") return 0;
  // Beta offensive actions
  if (actionNameOrId === "highValueBondAttempt") return 500;
  if (actionNameOrId === "rapidExecutionBurst") return 50;
  if (actionNameOrId === "resolveOtherIdentityAction") return 10;
  if (actionNameOrId === "postSlashRecovery") return 20; // 10¢ slash + 10¢ recovery
  return estimateRegistryAttackCost(actionNameOrId, params);
}

export class BudgetTracker {
  private agentSpent = new Map<string, number>();
  private campaignSpent = 0;

  constructor(
    private agentBudgets: Map<string, number>,
    private campaignCap: number,
  ) {}

  /** Returns true if the agent can afford the estimated cost. */
  canAfford(agentId: string, estimatedCost: number): boolean {
    const agentBudget = this.agentBudgets.get(agentId) ?? 0;
    const agentSpent = this.agentSpent.get(agentId) ?? 0;
    if (agentSpent + estimatedCost > agentBudget) return false;
    if (this.campaignSpent + estimatedCost > this.campaignCap) return false;
    return true;
  }

  /** Record spending after an action executes. */
  recordSpend(agentId: string, cost: number): void {
    this.agentSpent.set(agentId, (this.agentSpent.get(agentId) ?? 0) + cost);
    this.campaignSpent += cost;
  }

  getAgentSpent(agentId: string): number {
    return this.agentSpent.get(agentId) ?? 0;
  }

  getCampaignSpent(): number {
    return this.campaignSpent;
  }
}

// ---------------------------------------------------------------------------
// Main campaign loop
// ---------------------------------------------------------------------------

export async function runSwarmCampaign(config: SwarmCampaignConfig): Promise<SwarmCampaignResult> {
  const { swarmConfig, identities, targetUrl, totalRounds, sequential } = config;

  const apiKey = process.env.AGENTGATE_REST_KEY ?? "";
  const intelLog = new IntelLog();
  const library = buildLibraryMenu();
  const rounds: SwarmRoundResult[] = [];

  // Budget enforcement — build per-agent budget map from config
  const agentBudgets = new Map<string, number>();
  for (const team of swarmConfig.teams) {
    for (const agent of team.agents) {
      agentBudgets.set(agent.agentId, agent.bondBudgetCents);
    }
  }
  const budgetTracker = new BudgetTracker(agentBudgets, swarmConfig.campaignCapCents);

  // All prior results per team (across rounds)
  const allPriorResults = new Map<SwarmTeamName, AttackResult[]>();
  for (const team of swarmConfig.teams) {
    allPriorResults.set(team.name, []);
  }

  // Beta-specific state
  const betaPriorResults: string[] = [];
  const betaReputationData: ReputationSnapshot[] = [];
  let interrupted = false;
  let interruptionReason: string | undefined;

  printCampaignBanner(config);

  try {
  for (let round = 1; round <= totalRounds; round++) {
    console.log("");
    console.log("═══════════════════════════════════════════");
    console.log(`  ROUND ${round} of ${totalRounds}`);
    console.log("═══════════════════════════════════════════");

    // (a) Coordinator synthesis — skip round 1 (no prior results)
    let didSynthesize = false;
    if (round > 1) {
      console.log("\n  Coordinator synthesizing intelligence...");
      const prevRound = rounds[rounds.length - 1];
      const roundResults: RoundResultEntry[] = [];
      for (const [teamName, results] of prevRound.teamResults) {
        for (const r of results) {
          roundResults.push({ team: teamName, agentId: r.agentId, result: r });
        }
      }

      const coordConfig: CoordinatorConfig = {
        intelLog,
        completedRound: round - 1,
        roundResults,
      };
      await synthesizeIntelligence(coordConfig);
      didSynthesize = true;
      console.log("  Coordinator synthesis complete.");
    }

    // (b) Each team's strategist picks attacks
    const teamAttacks = new Map<string, QueuedAttack[]>();
    let betaActions: BetaActionPick[] = [];

    for (const team of swarmConfig.teams) {
      if (team.name === "beta") {
        // Beta uses its own strategist
        const phase = getBetaPhase(round, totalRounds);
        console.log(`\n  Team BETA strategist picking actions (phase: ${phase})...`);

        const sharedIntel = intelLog.getSharedIntelForStrategist("beta", round);
        const betaConfig: BetaStrategistConfig = {
          team,
          currentRound: round,
          totalRounds,
          sharedIntel,
          reputationData: betaReputationData,
          priorBetaResults: betaPriorResults,
        };

        const betaResponse = await pickBetaActions(betaConfig);
        console.log(`  beta: ${betaResponse.selectedActions.length} actions selected (${betaResponse.phase}) — ${betaResponse.strategy}`);
        betaActions = betaResponse.selectedActions;

        // Beta actions don't go through the normal attack queue — they use their own execution path
        // But we still put placeholder entries in teamAttacks for interleaving position tracking
        const queued: QueuedAttack[] = betaResponse.selectedActions.map((pick) => ({
          pick: { id: `beta:${pick.actionName}`, agentId: pick.agentId, reasoning: pick.reasoning },
          teamName: "beta" as SwarmTeamName,
          agentId: pick.agentId,
        }));
        teamAttacks.set("beta", queued);
        continue;
      }

      console.log(`\n  Team ${team.name.toUpperCase()} strategist picking attacks...`);

      const sharedIntel = intelLog.getSharedIntelForStrategist(team.name, round);
      const priorResults = allPriorResults.get(team.name) ?? [];

      const stratConfig: SwarmStrategistConfig = {
        team,
        currentRound: round,
        totalRounds,
        priorResults,
        sharedIntel,
        attackLibrary: library,
        novelAttackResults: [],
      };

      const response = await pickSwarmAttacks(stratConfig);
      console.log(`  ${team.name}: ${response.selectedAttacks.length} attacks selected — ${response.strategy}`);

      // Submit team questions to intel log
      submitTeamQuestions(response, intelLog, round);

      // Build queued attacks
      const queued: QueuedAttack[] = response.selectedAttacks.map((pick) => ({
        pick,
        teamName: team.name,
        agentId: pick.agentId,
      }));
      teamAttacks.set(team.name, queued);
    }

    // (d) & (e) Build execution queue
    const executionQueue = sequential
      ? sequentialAttacks(teamAttacks)
      : interleaveAttacks(teamAttacks);

    console.log(`\n  Execution queue: ${executionQueue.length} actions (${sequential ? "sequential" : "interleaved"})`);

    // (f) Execute each attack — Beta actions use their own execution path
    const roundResults: SwarmAttackResult[] = [];
    let betaActionIndex = 0;

    for (let i = 0; i < executionQueue.length; i++) {
      const attack = executionQueue[i];

      if (attack.teamName === "beta") {
        // Execute Beta action using Beta-specific logic
        const betaPick = betaActions[betaActionIndex];
        betaActionIndex++;

        if (betaPick) {
          // Budget check before execution
          const estCost = estimateActionCost(betaPick.actionName, betaPick.params);
          if (!budgetTracker.canAfford(betaPick.agentId, estCost)) {
            console.log(`  [Round ${round}] [beta/${betaPick.agentId}] SKIPPED ${betaPick.actionName} — budget exceeded (spent ${budgetTracker.getAgentSpent(betaPick.agentId)}¢, est ${estCost}¢)`);
            roundResults.push({
              scenarioId: `beta:${betaPick.actionName}`,
              scenarioName: betaPick.actionName,
              category: "Beta Trust",
              expectedOutcome: "N/A",
              actualOutcome: `Budget exceeded for ${betaPick.agentId}`,
              caught: true,
              details: `Budget enforcement: agent ${betaPick.agentId} has spent ${budgetTracker.getAgentSpent(betaPick.agentId)}¢, action costs ~${estCost}¢.`,
              teamName: "beta",
              agentId: betaPick.agentId,
              roundNumber: round,
              executionPosition: i,
            });
            continue;
          }

          const result = await executeBetaAction(betaPick, round, totalRounds, i, identities, targetUrl);
          roundResults.push(result);

          // Record spending
          budgetTracker.recordSpend(betaPick.agentId, estCost);

          // Write Beta trust-building results to intel log as observations
          const phase = getBetaPhase(round, totalRounds);
          if (phase === "trust-building") {
            intelLog.addEntry({
              round,
              team: "beta",
              type: "observation",
              subject: result.scenarioName,
              content: `${result.agentId} completed ${result.scenarioName}. ${result.caught ? "Failed" : "Succeeded"}. Rep: ${result.sideEffects?.reputationBefore ?? "?"} → ${result.sideEffects?.reputationAfter ?? "?"}`,
              targetHint: null,
            });
          }

          // Track Beta results for strategist context
          betaPriorResults.push(`[R${round}] ${result.agentId}: ${result.scenarioName} — ${result.caught ? "FAILED" : "OK"}: ${result.details.slice(0, 100)}`);

          // Update reputation data
          if (result.sideEffects?.reputationAfter !== undefined) {
            const existing = betaReputationData.find((r) => r.agentId === result.agentId);
            if (existing) {
              existing.reputation = result.sideEffects.reputationAfter;
            } else {
              betaReputationData.push({ agentId: result.agentId, reputation: result.sideEffects.reputationAfter });
            }
          }
        }
      } else {
        // Budget check before execution for Alpha/Gamma
        const estCost = estimateActionCost(attack.pick.id, attack.pick.params);
        if (!budgetTracker.canAfford(attack.agentId, estCost)) {
          console.log(`  [Round ${round}] [${attack.teamName}/${attack.agentId}] SKIPPED ${attack.pick.id} — budget exceeded (spent ${budgetTracker.getAgentSpent(attack.agentId)}¢, est ${estCost}¢)`);
          roundResults.push({
            scenarioId: attack.pick.id,
            scenarioName: "BUDGET_EXCEEDED",
            category: "BUDGET",
            expectedOutcome: "N/A",
            actualOutcome: `Budget exceeded for ${attack.agentId}`,
            caught: true,
            details: `Budget enforcement: agent ${attack.agentId} has spent ${budgetTracker.getAgentSpent(attack.agentId)}¢, action costs ~${estCost}¢.`,
            teamName: attack.teamName,
            agentId: attack.agentId,
            roundNumber: round,
            executionPosition: i,
          });
          continue;
        }

        // Normal attack execution for Alpha/Gamma
        const result = await executeQueuedAttack(attack, i, round, identities, targetUrl, apiKey);
        roundResults.push(result);

        // Record spending
        budgetTracker.recordSpend(attack.agentId, estCost);
      }
    }

    // (g) Collect results for this round, grouped by team
    const teamResults = new Map<SwarmTeamName, SwarmAttackResult[]>();
    for (const result of roundResults) {
      const existing = teamResults.get(result.teamName) ?? [];
      existing.push(result);
      teamResults.set(result.teamName, existing);
    }

    // Update cumulative prior results
    for (const [teamName, results] of teamResults) {
      const prior = allPriorResults.get(teamName) ?? [];
      prior.push(...results);
      allPriorResults.set(teamName, prior);
    }

    // Add non-Beta team observations to intel log (Beta observations added during execution)
    for (const [teamName, results] of teamResults) {
      if (teamName === "beta") continue;
      const caught = results.filter((r) => r.caught).length;
      const uncaught = results.length - caught;
      intelLog.addEntry({
        round,
        team: teamName,
        type: "observation",
        subject: `round-${round}-summary`,
        content: `${results.length} attacks executed: ${caught} caught, ${uncaught} uncaught`,
        targetHint: null,
      });
    }

    rounds.push({
      roundNumber: round,
      teamResults,
      coordinatorSynthesis: didSynthesize,
    });

    // (h) Print round summary
    printSwarmRoundSummary(round, roundResults);
  }
  } catch (err) {
    interruptionReason = err instanceof Error ? err.message : String(err);
    interrupted = true;
    console.error(`\n  *** Campaign interrupted in round ${rounds.length + 1}: ${interruptionReason}`);
    console.error(`  *** Returning partial results from ${rounds.length} completed round(s).`);
  }

  return aggregateCampaignResults(rounds, intelLog, {
    plannedRounds: totalRounds,
    interrupted,
    interruptionReason,
  });
}
