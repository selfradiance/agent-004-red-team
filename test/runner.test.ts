// Integration tests for the attack runner — requires live AgentGate

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { runAllAttacksStatic, runSelectedAttacks } from "../src/runner";
import { signRequest } from "../src/agentgate-client";
import type { AttackClient } from "../src/attacks/replay";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

function createFreshClient(): { promise: Promise<AttackClient> } {
  const promise = (async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    const privateJwk = privateKey.export({ format: "jwk" });

    const keys = {
      publicKey: base64UrlToBase64(publicJwk.x!),
      privateKey: base64UrlToBase64(privateJwk.d!),
    };

    const agentGateUrl = process.env.AGENTGATE_URL ?? "http://127.0.0.1:3000";
    const apiKey = process.env.AGENTGATE_REST_KEY!;

    const nonce = randomUUID();
    const timestamp = Date.now().toString();
    const apiPath = "/v1/identities";
    const body = { publicKey: keys.publicKey };
    const signature = signRequest(keys.publicKey, keys.privateKey, nonce, "POST", apiPath, timestamp, body);

    const response = await fetch(new URL(apiPath, agentGateUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nonce": nonce,
        "x-agentgate-key": apiKey,
        "x-agentgate-timestamp": timestamp,
        "x-agentgate-signature": signature,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Failed to create identity: ${JSON.stringify(data)}`);
    }

    return {
      agentGateUrl,
      apiKey,
      keys,
      identityId: data.identityId as string,
    };
  })();

  return { promise };
}

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "runner — static mode against live AgentGate",
  () => {
    let client: AttackClient;

    beforeAll(async () => {
      client = await createFreshClient().promise;
    });

    it("all attacks are caught by AgentGate (static)", { timeout: 120000 }, async () => {
      const results = await runAllAttacksStatic(client);

      expect(results.length).toBeGreaterThanOrEqual(15);

      const uncaught = results.filter((r) => !r.caught);
      if (uncaught.length > 0) {
        const summary = uncaught.map((r) => `${r.scenarioId}: ${r.scenarioName} — ${r.details}`).join("\n");
        throw new Error(`${uncaught.length} attack(s) were NOT caught:\n${summary}`);
      }

      for (const result of results) {
        expect(result.caught).toBe(true);
      }
    });
  },
);

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "runner — runSelectedAttacks against live AgentGate",
  () => {
    let client: AttackClient;

    beforeAll(async () => {
      client = await createFreshClient().promise;
    });

    it("runs valid attack picks and returns results", { timeout: 30000 }, async () => {
      const picks = [
        { id: "1.1", reasoning: "test pick" },
        { id: "3.3", reasoning: "test pick" },
      ];

      const results = await runSelectedAttacks(picks, client, 1);

      expect(results).toHaveLength(2);
      expect(results[0].scenarioId).toBe("1.1");
      expect(results[1].scenarioId).toBe("3.3");
      expect(results[0].caught).toBe(true);
      expect(results[1].caught).toBe(true);
    });

    it("returns uncaught result for unknown scenario ID", { timeout: 10000 }, async () => {
      const picks = [
        { id: "99.99", reasoning: "nonexistent scenario" },
      ];

      const results = await runSelectedAttacks(picks, client, 1);

      expect(results).toHaveLength(1);
      expect(results[0].scenarioId).toBe("99.99");
      expect(results[0].caught).toBe(false);
      expect(results[0].actualOutcome).toContain("not found in registry");
    });
  },
);
