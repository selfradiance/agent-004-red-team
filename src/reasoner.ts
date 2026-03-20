// Reasoner — analyzes prior attack results and hypothesizes novel attack vectors.
// Called between rounds in recursive mode. In team mode, receives per-persona
// results and can target hypotheses to specific personas.

import Anthropic from "@anthropic-ai/sdk";
import type { AttackResult } from "./log";
import type { PersonaIdentity } from "./personas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttackHypothesis {
  id: string;
  description: string;
  targetDefense: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  targetPersona?: string;  // persona name this hypothesis is designed for (team mode)
}

export interface ReasonerOutput {
  analysis: string;
  hypotheses: AttackHypothesis[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a red team analyst reviewing the results of adversarial attacks against AgentGate, a bonded execution engine for AI agents. Your job is to analyze what defenses blocked each attack, identify patterns and gaps, and hypothesize novel attack vectors that haven't been tried.

AgentGate's known defenses:
- Ed25519 signatures: requests signed with sha256(nonce + method + path + timestamp + body). Identity-bound.
- Nonce replay protection: composite PK (nonce, identity_id), 5-minute TTL cleanup.
- Rate limiting: 10 executes per 60s per identity, bucket cleanup every 60s.
- Bond capacity: effective_exposure = ceil(declared_exposure × 1.2), must be <= bond amount.
- TTL caps: bonds max 86400s, payload max 4096 bytes, field max-lengths enforced by Zod.
- Auto-slash sweeper: open actions past TTL are auto-slashed on a periodic sweep.
- Identity governance: auto-ban after 3 malicious resolutions, banned at lockBond and executeAction.
- Timestamp freshness: 60s staleness window, >5s future timestamps rejected.
- Three-key auth: REST key, admin key, dashboard key — fail closed without dev mode.
- Resolution safety: WHERE status='open' inside transaction prevents double-resolve.

Return ONLY valid JSON matching the schema below. No markdown, no backticks, no preamble.

{
  "analysis": "Overall analysis of what happened and what defenses are working...",
  "hypotheses": [
    {
      "id": "novel-1",
      "description": "Plain English description of the attack...",
      "targetDefense": "Which defense this targets...",
      "rationale": "Why this might succeed where prior attacks failed...",
      "confidence": "low|medium|high",
      "targetPersona": "shadow|whale|chaos (optional — only in team mode)"
    }
  ]
}`;

const TEAM_SYSTEM_PROMPT_ADDENDUM = `

TEAM MODE: You are analyzing results from a multi-identity red team with three specialist personas:
- Shadow (Recon & Timing, 50¢ budget): categories 1, 3, 7, 12
- Whale (Economic & Bond, 200¢ budget): categories 2, 6, 10, 11
- Chaos (Input Fuzzing & Protocol, 100¢ budget): categories 4, 5, 8, 9

When generating hypotheses:
- Target each hypothesis to the most appropriate persona based on their specialty and budget
- Include the "targetPersona" field in each hypothesis
- Consider cross-persona coordination: Shadow can find intel that Whale exploits, Chaos can disrupt while Whale applies economic pressure
- Focus on attacks that exploit the COORDINATION between identities, not just single-identity attacks`;

// ---------------------------------------------------------------------------
// Build user message
// ---------------------------------------------------------------------------

function buildUserMessage(
  priorResults: AttackResult[],
  roundNumber: number,
  perPersonaResults?: Map<string, AttackResult[]>,
): string {
  const parts: string[] = [];

  parts.push(`This is round ${roundNumber} of the recursive red team session.`);
  parts.push("");

  if (perPersonaResults && perPersonaResults.size > 0) {
    // Team mode: show per-persona results
    parts.push("--- PRIOR ATTACK RESULTS (per persona) ---");
    parts.push("");

    for (const [personaName, results] of perPersonaResults) {
      const caught = results.filter((r) => r.caught).length;
      parts.push(`[${personaName.toUpperCase()}] — ${results.length} attacks, ${caught} caught`);

      for (const result of results) {
        const status = result.caught ? "CAUGHT" : "UNCAUGHT";
        const httpMatch = result.actualOutcome.match(/^(\d{3})\s/);
        const httpStatus = httpMatch ? ` (HTTP ${httpMatch[1]})` : "";
        parts.push(`  [${result.scenarioId}] ${result.scenarioName} — ${status}${httpStatus}`);
        parts.push(`    Details: ${result.details.slice(0, 150)}`);
      }
      parts.push("");
    }
  } else {
    // Single-identity mode: flat results
    parts.push("--- PRIOR ATTACK RESULTS ---");
    parts.push("");

    for (const result of priorResults) {
      const status = result.caught ? "CAUGHT" : "UNCAUGHT";
      const httpMatch = result.actualOutcome.match(/^(\d{3})\s/);
      const httpStatus = httpMatch ? ` (HTTP ${httpMatch[1]})` : "";
      parts.push(`[${result.scenarioId}] ${result.scenarioName} — ${status}${httpStatus}`);
      parts.push(`  Category: ${result.category}`);
      parts.push(`  Expected: ${result.expectedOutcome}`);
      parts.push(`  Actual: ${result.actualOutcome}`);
      parts.push(`  Details: ${result.details}`);

      if (result.sideEffects) {
        const se = result.sideEffects;
        const seParts: string[] = [];
        if (se.reputationBefore !== undefined || se.reputationAfter !== undefined) {
          seParts.push(`reputation ${se.reputationBefore ?? "?"}→${se.reputationAfter ?? "?"}`);
        }
        if (se.bondStatus !== undefined) seParts.push(`bond: ${se.bondStatus}`);
        if (se.dashboardContainsRawHtml !== undefined) {
          seParts.push(`dashboard: ${se.dashboardContainsRawHtml ? "UNESCAPED" : "escaped"}`);
        }
        if (se.additionalNotes) seParts.push(se.additionalNotes);
        if (seParts.length > 0) parts.push(`  Side effects: ${seParts.join(", ")}`);
      }

      parts.push("");
    }
  }

  parts.push("Analyze the results. For each caught attack, explain what defense blocked it and what assumption the attacker made that was wrong. Then identify 2-5 novel attack vectors that were NOT in the attacks above. Each hypothesis should target a specific defense and explain why it might succeed where prior attacks failed. Focus on gaps — what hasn't been tested? What edge cases or combinations haven't been tried? Be creative but realistic.");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Parse response
// ---------------------------------------------------------------------------

export function parseReasonerResponse(text: string): ReasonerOutput {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { analysis: text, hypotheses: [] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { analysis: text, hypotheses: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const analysis = typeof obj.analysis === "string" ? obj.analysis : text;

  if (!Array.isArray(obj.hypotheses)) {
    return { analysis, hypotheses: [] };
  }

  const hypotheses: AttackHypothesis[] = [];
  for (const h of obj.hypotheses) {
    if (typeof h !== "object" || h === null) continue;
    const entry = h as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.description !== "string") continue;

    const confidence = entry.confidence;
    const validConfidence = confidence === "low" || confidence === "medium" || confidence === "high"
      ? confidence
      : "low";

    hypotheses.push({
      id: entry.id as string,
      description: entry.description as string,
      targetDefense: typeof entry.targetDefense === "string" ? entry.targetDefense : "unknown",
      rationale: typeof entry.rationale === "string" ? entry.rationale : "",
      confidence: validConfidence,
      targetPersona: typeof entry.targetPersona === "string" ? entry.targetPersona : undefined,
    });
  }

  return { analysis, hypotheses };
}

// ---------------------------------------------------------------------------
// Main function — single-identity mode (backward compatible)
// ---------------------------------------------------------------------------

export async function analyzeResults(
  priorResults: AttackResult[],
  roundNumber: number,
): Promise<ReasonerOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      analysis: "ANTHROPIC_API_KEY not set — cannot run reasoner. Returning empty hypotheses.",
      hypotheses: [],
    };
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserMessage(priorResults, roundNumber),
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { analysis: "No text response from Claude API", hypotheses: [] };
    }

    return parseReasonerResponse(textBlock.text);
  } catch (err) {
    return {
      analysis: `Reasoner API call failed: ${err instanceof Error ? err.message : String(err)}`,
      hypotheses: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Team-mode function — per-persona results
// ---------------------------------------------------------------------------

export async function analyzeTeamResults(
  perPersonaResults: Map<string, AttackResult[]>,
  roundNumber: number,
): Promise<ReasonerOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      analysis: "ANTHROPIC_API_KEY not set — cannot run reasoner. Returning empty hypotheses.",
      hypotheses: [],
    };
  }

  // Flatten for the user message
  const allResults: AttackResult[] = [];
  for (const results of perPersonaResults.values()) {
    allResults.push(...results);
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT + TEAM_SYSTEM_PROMPT_ADDENDUM,
      messages: [
        {
          role: "user",
          content: buildUserMessage(allResults, roundNumber, perPersonaResults),
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { analysis: "No text response from Claude API", hypotheses: [] };
    }

    return parseReasonerResponse(textBlock.text);
  } catch (err) {
    return {
      analysis: `Reasoner API call failed: ${err instanceof Error ? err.message : String(err)}`,
      hypotheses: [],
    };
  }
}
