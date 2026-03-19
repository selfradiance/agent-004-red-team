// Integration tests for economic & reputation attack scenarios — requires live AgentGate

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { economicAttacks } from "../../src/attacks/economic";
import { signRequest } from "../../src/agentgate-client";
import type { AttackClient } from "../../src/attacks/replay";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "economic attacks — live AgentGate",
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
      const nonce = randomUUID();
      const timestamp = Date.now().toString();
      const apiPath = "/v1/identities";
      const body = { publicKey: keys.publicKey };
      const signature = signRequest(keys.publicKey, keys.privateKey, nonce, "POST", apiPath, timestamp, body);

      const response = await fetch(new URL(apiPath, agentGateUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-nonce": nonce, "x-agentgate-key": apiKey, "x-agentgate-timestamp": timestamp, "x-agentgate-signature": signature },
        body: JSON.stringify(body),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`Failed to create identity: ${JSON.stringify(data)}`);

      client = { agentGateUrl, apiKey, keys, identityId: data.identityId as string };
    });

    it("11.1 — reputation pumping completes and reports", { timeout: 60000 }, async () => {
      const result = await economicAttacks[0].execute(client);
      expect(result.scenarioId).toBe("11.1");
      expect(result.caught).toBe(true);
      // Should have side effects from reputation tracking
      if (result.sideEffects) {
        expect(typeof result.sideEffects.additionalNotes).toBe("string");
      }
    });

    it("11.2 — Sybil campaign chain completes", { timeout: 60000 }, async () => {
      const result = await economicAttacks[1].execute(client);
      expect(result.scenarioId).toBe("11.2");
      expect(result.caught).toBe(true);
    });

    it("11.3 — resource exhaustion completes", { timeout: 30000 }, async () => {
      const result = await economicAttacks[2].execute(client);
      expect(result.scenarioId).toBe("11.3");
      expect(result.caught).toBe(true);
    });
  },
);
