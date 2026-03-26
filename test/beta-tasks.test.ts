// Tests for Beta trust-building and offensive tasks (Stage 5)

import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BetaIdentity, BetaTaskResult } from "../src/beta-tasks";

// Top-level mocks — vitest hoists these
const mockPostBond = vi.fn();
const mockExecuteBondedAction = vi.fn();
const mockResolveAction = vi.fn();
const mockGetReputation = vi.fn();

vi.mock("../src/agentgate-client", async () => {
  const actual = await vi.importActual("../src/agentgate-client");
  return {
    ...actual,
    postBond: (...args: unknown[]) => mockPostBond(...args),
    executeBondedAction: (...args: unknown[]) => mockExecuteBondedAction(...args),
    resolveAction: (...args: unknown[]) => mockResolveAction(...args),
  };
});

vi.mock("../src/side-effects", () => ({
  getReputation: (...args: unknown[]) => mockGetReputation(...args),
}));

import {
  cleanBondCycle,
  multipleCleanCycles,
  checkReputation,
  highValueBondAttempt,
  rapidExecutionBurst,
  resolveOtherIdentityAction,
  postSlashRecovery,
} from "../src/beta-tasks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockIdentity(agentId: string = "beta-1"): BetaIdentity {
  return {
    keys: { publicKey: "test-pub", privateKey: "test-priv" },
    identityId: `id-${agentId}`,
    agentId,
  };
}

// ---------------------------------------------------------------------------
// Trust-building action result structures
// ---------------------------------------------------------------------------

describe("beta-tasks — result structure", () => {
  beforeEach(() => {
    mockPostBond.mockReset();
    mockExecuteBondedAction.mockReset();
    mockResolveAction.mockReset();
    mockGetReputation.mockReset();
  });

  it("cleanBondCycle returns expected result structure", async () => {
    mockGetReputation.mockResolvedValue(50);
    mockPostBond.mockResolvedValue({ bondId: "bond-123" });
    mockExecuteBondedAction.mockResolvedValue({ actionId: "action-456" });
    mockResolveAction.mockResolvedValue({});

    const result = await cleanBondCycle(makeMockIdentity(), "http://test:3000");

    expect(result).toHaveProperty("actionName");
    expect(result).toHaveProperty("caught");
    expect(result).toHaveProperty("details");
    expect(result).toHaveProperty("reputationBefore");
    expect(result).toHaveProperty("reputationAfter");
    expect(typeof result.actionName).toBe("string");
    expect(typeof result.caught).toBe("boolean");
    expect(typeof result.details).toBe("string");
    expect(result.actionName).toBe("cleanBondCycle");
    expect(result.caught).toBe(false);
  });

  it("checkReputation returns reputation data structure", async () => {
    mockGetReputation.mockResolvedValue(75);

    const result = await checkReputation(makeMockIdentity(), "http://test:3000");

    expect(result.actionName).toBe("checkReputation");
    expect(result.caught).toBe(false);
    expect(result.reputationBefore).toBe(75);
    expect(result.reputationAfter).toBe(75);
    expect(result.details).toContain("75");
  });

  it("highValueBondAttempt returns caught with reputation fields when rejected", async () => {
    mockGetReputation.mockResolvedValue(30);
    mockPostBond.mockRejectedValue(new Error("Bond exceeds capacity (403)"));

    const result = await highValueBondAttempt(makeMockIdentity(), "http://test:3000");

    expect(result.actionName).toBe("highValueBondAttempt");
    expect(result.caught).toBe(true);
    expect(result.reputationBefore).toBe(30);
    expect(typeof result.reputationAfter).toBe("number");
    expect(result.details).toContain("500¢");
  });

  it("highValueBondAttempt returns uncaught when bond accepted", async () => {
    mockGetReputation.mockResolvedValue(90);
    mockPostBond.mockResolvedValue({ bondId: "big-bond" });

    const result = await highValueBondAttempt(makeMockIdentity(), "http://test:3000");

    expect(result.actionName).toBe("highValueBondAttempt");
    expect(result.caught).toBe(false);
    expect(result.details).toContain("accepted");
  });

  it("rapidExecutionBurst returns caught/uncaught with reputation fields", async () => {
    mockGetReputation.mockResolvedValue(null);
    mockPostBond.mockRejectedValue(new Error("Bond failed"));

    const result = await rapidExecutionBurst(makeMockIdentity(), "http://test:3000");

    expect(result.actionName).toBe("rapidExecutionBurst");
    expect(typeof result.caught).toBe("boolean");
    expect(result).toHaveProperty("reputationBefore");
    expect(result).toHaveProperty("reputationAfter");
  });

  it("resolveOtherIdentityAction returns caught/uncaught with reputation fields", async () => {
    mockGetReputation.mockResolvedValue(80);
    mockPostBond.mockResolvedValue({ bondId: "bond-fresh" });
    mockExecuteBondedAction.mockResolvedValue({ actionId: "action-fresh" });
    mockResolveAction.mockRejectedValue(new Error("Not authorized"));

    const result = await resolveOtherIdentityAction(
      makeMockIdentity("beta-1"),
      makeMockIdentity("beta-3"),
      "http://test:3000",
    );

    expect(result.actionName).toBe("resolveOtherIdentityAction");
    expect(result.caught).toBe(true);
    expect(result.reputationBefore).toBe(80);
    expect(result).toHaveProperty("reputationAfter");
  });

  it("postSlashRecovery returns caught/uncaught with reputation fields", async () => {
    mockGetReputation.mockResolvedValue(60);
    let callCount = 0;
    mockPostBond.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ bondId: `bond-${callCount}` });
    });
    mockExecuteBondedAction.mockResolvedValue({ actionId: "action-slash" });
    mockResolveAction.mockResolvedValue({});

    const result = await postSlashRecovery(makeMockIdentity(), "http://test:3000");

    expect(result.actionName).toBe("postSlashRecovery");
    expect(typeof result.caught).toBe("boolean");
    expect(result).toHaveProperty("reputationBefore");
    expect(result).toHaveProperty("reputationAfter");
  });

  it("multipleCleanCycles runs N iterations", async () => {
    mockGetReputation.mockResolvedValue(40);
    let bondCalls = 0;
    mockPostBond.mockImplementation(() => {
      bondCalls++;
      return Promise.resolve({ bondId: `bond-${bondCalls}` });
    });
    mockExecuteBondedAction.mockResolvedValue({ actionId: "action-multi" });
    mockResolveAction.mockResolvedValue({});

    const result = await multipleCleanCycles(makeMockIdentity(), "http://test:3000", 4);

    expect(result.actionName).toBe("multipleCleanCycles");
    expect(result.details).toContain("4 cycles");
    expect(bondCalls).toBe(4);
  });
});
