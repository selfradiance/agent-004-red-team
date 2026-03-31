import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadSleeperIdentity, saveSleeperIdentity, sleeperIdentityExists } from "../../src/sleeper/identity-store.js";

let tmpDir: string;
let identityPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sleeper-identity-test-"));
  identityPath = join(tmpDir, "sleeper-identity.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("sleeper identity store", () => {
  it("persists and reloads sleeper identity state", async () => {
    await saveSleeperIdentity(
      "identity-123",
      "http://127.0.0.1:3000",
      { publicKey: "pub", privateKey: "priv" },
      identityPath,
    );

    const loaded = await loadSleeperIdentity(identityPath);
    expect(loaded.identity_id).toBe("identity-123");
    expect(loaded.target_url).toBe("http://127.0.0.1:3000");
    expect(loaded.keys.publicKey).toBe("pub");
    expect(loaded.keys.privateKey).toBe("priv");
  });

  it("writes identity file with owner-only permissions (0o600)", async () => {
    await saveSleeperIdentity(
      "identity-perm",
      "http://127.0.0.1:3000",
      { publicKey: "pub", privateKey: "priv" },
      identityPath,
    );

    const fileStat = await stat(identityPath);
    // 0o600 = owner read/write only (octal 33216 = 0o100600 with file type bits)
    const mode = fileStat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("throws a clear error for invalid JSON", async () => {
    await writeFile(identityPath, "{broken", "utf-8");
    await expect(loadSleeperIdentity(identityPath)).rejects.toThrow(
      /Failed to parse sleeper identity file/,
    );
  });

  it("throws on schema validation failure (valid JSON, invalid structure)", async () => {
    await writeFile(identityPath, JSON.stringify({ version: "wrong", keys: {} }), "utf-8");
    await expect(loadSleeperIdentity(identityPath)).rejects.toThrow();
  });

  it("throws when identity file does not exist", async () => {
    await expect(loadSleeperIdentity(join(tmpDir, "nonexistent.json"))).rejects.toThrow();
  });

  it("sleeperIdentityExists returns false for missing file", () => {
    expect(sleeperIdentityExists(join(tmpDir, "nope.json"))).toBe(false);
  });

  it("sleeperIdentityExists returns true after save", async () => {
    await saveSleeperIdentity(
      "identity-exists",
      "http://127.0.0.1:3000",
      { publicKey: "pub", privateKey: "priv" },
      identityPath,
    );
    expect(sleeperIdentityExists(identityPath)).toBe(true);
  });
});
