# Agent 004: Red Team Simulator

An external adversarial test rig for AgentGate. It attacks a live AgentGate instance from the outside over HTTP — the way a real adversary would — and reports which defenses held and which did not.

## Why This Exists

AI agents are being deployed with broad access and zero adversarial testing. AgentGate has internal red team tests, but those run inside the codebase with direct database access. That's not how real attackers work. Agent 004 attacks from the outside, with its own identity and its own consequences.

The question it answers: can AgentGate's bond-and-slash model withstand systematic adversarial probing from an external agent?

## How It Relates to AgentGate

[AgentGate](https://github.com/selfradiance/agentgate) is both the enforcement substrate AND the attack target. Agent 004 calls AgentGate's API for identity and bond management, and also sends intentionally malformed and adversarial requests to test AgentGate's defenses.

AgentGate must be running for Agent 004 to work.

## Five Stages

The simulator was built progressively, each stage harder than the last:

| Stage | Version | What it does |
|-------|---------|-------------|
| **Static** | v0.1.0 | 15 predefined attacks across 6 categories (replay, bond capacity, signature tampering, authorization, input validation, rate limiting) |
| **Adaptive** | v0.2.0 | Claude-powered strategist generates 48 attack scenarios across 12 categories based on AgentGate's actual API responses |
| **Recursive** | v0.3.0 | Claude generates novel JavaScript attack code, executed in a sandboxed child process with a 4-layer defense model (Node 22 permission flags, global nullification, IPC-only toolkit, string-level validator) |
| **Coordinated Team** | v0.4.0 | Three specialist personas (Shadow, Whale, Chaos) with distinct bond budgets and attack-family priorities, coordinated by the strategist |
| **Coordinated Swarms** | v0.5.0 | Three teams of three agents (9 identities), per-team strategists, campaign coordinator, interleaved execution, shared intelligence log. 5-round campaigns. Three-tier provenance in reporting. |

### Sleeper Agent (v0.6.0)

A temporal attack pattern: the agent scouts AgentGate's defenses during a compliant bonded session, releases its bond cleanly, then returns later armed with the reconnaissance it gathered. Tests whether AgentGate can govern information extraction, not just action integrity. Includes same-identity vs. fresh-identity modes and a blind baseline (control group).

## What's Implemented

- 15 static attack scenarios + Claude-generated adaptive and recursive attacks
- Four-layer sandbox for generated attack code
- Three-persona coordinated teams (Shadow, Whale, Chaos)
- Nine-agent coordinated swarms with campaign coordination
- Sleeper agent scout/strike temporal pattern with recon file persistence
- Claude API findings report generation with three-tier provenance classification
- Full AgentGate lifecycle per attack: identity → bond → attack → resolve
- Ed25519 signed requests

## Quick Start

```bash
# 1. Start AgentGate
cd ~/Desktop/projects/agentgate && npm run restart

# 2. Run Agent 004
cd ~/Desktop/projects/agent-004-red-team
cp .env.example .env  # add AGENTGATE_REST_KEY and ANTHROPIC_API_KEY
npm install

# Static attacks
npx tsx src/cli.ts

# Adaptive attacks
npx tsx src/cli.ts --adaptive

# Full swarm campaign
npx tsx src/cli.ts --swarm

# Sleeper agent scout + strike
npx tsx src/cli.ts --scout
npx tsx src/cli.ts --strike --recon-file recon.json
```

## Key Result

Across all five stages plus the sleeper agent: AgentGate held. 97 offensive attacks in the swarm campaign, 0 swarm-emergent findings. The swarm did surface a legitimate governance limitation (no reputation-gated capacity), which was then implemented and re-tested.

## Scope / Non-Goals

- Attacks over HTTP only — no database-level or code-level access
- Single AgentGate instance — no distributed testing
- Swarm-sleeper integration is future work
- This is a test rig, not a production security tool

## Tests

330 tests across multiple test files, covering all five stages plus the sleeper agent.

```bash
npm test
```

## Related Projects

- [AgentGate](https://github.com/selfradiance/agentgate) — the attack target and enforcement substrate
- [Agent 005: Recursive Verifier](https://github.com/selfradiance/agentgate-recursive-verifier) — reuses Agent 004's sandbox architecture for constructive verification
- [Agent 006: Incentive Wargame](https://github.com/selfradiance/agentgate-incentive-wargame) — stress-tests economic rules

## Status

Complete — v0.6.0 shipped. Triple-audited (Claude Code 8-round + Codex cold-eyes + Claude Code cross-verification). 330 tests.

## License

MIT
