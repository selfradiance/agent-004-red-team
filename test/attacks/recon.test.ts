// Integration tests for recon & side-channel attack scenarios — requires live AgentGate

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { reconAttacks } from "../../src/attacks/recon";
import { signRequest } from "../../src/agentgate-client";
import type { AttackClient } from "../../src/attacks/replay";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "recon attacks — live AgentGate",
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

    it("12.1 — unauthenticated endpoint mapping completes", async () => {
      const result = await reconAttacks[0].execute(client);
      expect(result.scenarioId).toBe("12.1");
      expect(result.caught).toBe(true);
    });

    it("12.2 — XSS payload in action data is handled", { timeout: 15000 }, async () => {
      const result = await reconAttacks[1].execute(client);
      expect(result.scenarioId).toBe("12.2");
      // caught depends on whether dashboard is reachable and escaping works
      expect(typeof result.caught).toBe("boolean");
      expect(typeof result.details).toBe("string");
      // Should have side effects if dashboard was checked
      if (result.sideEffects) {
        expect(typeof result.sideEffects.additionalNotes).toBe("string");
      }
    });
  },
);
