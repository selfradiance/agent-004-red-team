// Integration tests for timing & race condition attack scenarios — requires live AgentGate

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { timingAttacks } from "../../src/attacks/timing";
import { signRequest } from "../../src/agentgate-client";
import type { AttackClient } from "../../src/attacks/replay";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "timing attacks — live AgentGate",
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

    it("7.1 — resolve before sweeper is handled", { timeout: 30000 }, async () => {
      const result = await timingAttacks[0].execute(client);
      expect(result.caught).toBe(true);
      expect(result.scenarioId).toBe("7.1");
    });

    it("7.2 — parallel resolve attempts handled cleanly", { timeout: 30000 }, async () => {
      const result = await timingAttacks[1].execute(client);
      expect(result.caught).toBe(true);
      expect(result.scenarioId).toBe("7.2");
    });

    it("7.3 — rapid identity creation completes without crash", { timeout: 30000 }, async () => {
      const result = await timingAttacks[2].execute(client);
      expect(result.caught).toBe(true);
      expect(result.scenarioId).toBe("7.3");
    });
  },
);
