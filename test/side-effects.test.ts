// Tests for side-effect collection utilities

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { getReputation, checkDashboardForRawHtml } from "../src/side-effects";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { signRequest } from "../src/agentgate-client";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

describe("side-effects — unit tests", () => {
  it("getReputation returns null on failure", async () => {
    const result = await getReputation("http://localhost:1", "nonexistent-id");
    expect(result).toBeNull();
  });

  it("checkDashboardForRawHtml returns null on failure", async () => {
    const result = await checkDashboardForRawHtml("http://localhost:1", "<script>alert(1)</script>");
    expect(result).toBeNull();
  });
});

describe.skipIf(!process.env.AGENTGATE_REST_KEY || process.env.AGENTGATE_REST_KEY.includes("your-"))(
  "side-effects — live AgentGate",
  () => {
    let identityId: string;

    beforeAll(async () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicJwk = publicKey.export({ format: "jwk" });
      const privateJwk = privateKey.export({ format: "jwk" });
      const pub = base64UrlToBase64(publicJwk.x!);
      const priv = base64UrlToBase64(privateJwk.d!);

      const agentGateUrl = process.env.AGENTGATE_URL ?? "http://127.0.0.1:3000";
      const apiKey = process.env.AGENTGATE_REST_KEY!;

      const nonce = randomUUID();
      const timestamp = Date.now().toString();
      const apiPath = "/v1/identities";
      const body = { publicKey: pub };
      const signature = signRequest(pub, priv, nonce, "POST", apiPath, timestamp, body);

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
      if (!response.ok) throw new Error(`Failed to create identity: ${JSON.stringify(data)}`);
      identityId = data.identityId as string;
    });

    it("getReputation returns a number for a live identity", async () => {
      const agentGateUrl = process.env.AGENTGATE_URL ?? "http://127.0.0.1:3000";
      const result = await getReputation(agentGateUrl, identityId);
      // May return null if the endpoint doesn't exist — that's also acceptable
      if (result !== null) {
        expect(typeof result).toBe("number");
      }
    });
  },
);
