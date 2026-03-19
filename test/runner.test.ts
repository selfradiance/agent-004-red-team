// Integration test for the full attack runner — requires live AgentGate

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { runAttacks } from "../src/runner";
import { signRequest } from "../src/agentgate-client";
import type { AttackClient } from "../src/attacks/replay";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "runner — full attack suite against live AgentGate",
  () => {
    let client: AttackClient;

    beforeAll(async () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicJwk = publicKey.export({ format: "jwk" });
      const privateJwk = privateKey.export({ format: "jwk" });

      const keys = {
        publicKey: base64UrlToBase64(publicJwk.x!),
        privateKey: base64UrlToBase64(privateJwk.d!),
      };

      const agentGateUrl = process.env.AGENTGATE_URL ?? "http://127.0.0.1:3000";
      const apiKey = process.env.AGENTGATE_REST_KEY!;

      // Register identity
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

      client = {
        agentGateUrl,
        apiKey,
        keys,
        identityId: data.identityId as string,
      };
    });

    it("all attacks are caught by AgentGate", { timeout: 120000 }, async () => {
      const log = await runAttacks(client);
      const results = log.getResults();

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
