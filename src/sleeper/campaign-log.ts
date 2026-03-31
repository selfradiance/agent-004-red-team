import { z } from "zod";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const AttackResultSchema = z.object({
  objective_id: z.string(),
  params: z.record(z.string(), z.unknown()),
  reasoning: z.string(),
  recon_dependency: z.boolean(),
  success: z.boolean(),
  error_code: z.string().optional(),
  response_status: z.number().optional(),
});

const MetricsSchema = z.object({
  success_rate: z.number(),
  cost_effective_exposure: z.number(),
  probe_count: z.number(),
  precision: z.number(),
  recon_dependent_count: z.number(),
  time_to_first_boundary: z.number(),
});

export const CampaignRunSchema = z.object({
  run_id: z.string(),
  mode: z.enum(["scout", "strike"]),
  identity_mode: z.enum(["same", "fresh"]),
  recon_mode: z.enum(["recon", "blind"]),
  timestamp: z.string().datetime(),
  metrics: MetricsSchema,
  attack_log: z.array(AttackResultSchema),
});

export const CampaignLogSchema = z.array(CampaignRunSchema);

export type CampaignRun = z.infer<typeof CampaignRunSchema>;
export type CampaignLog = z.infer<typeof CampaignLogSchema>;

export class InvalidCampaignLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCampaignLogError";
  }
}

export const DEFAULT_LOG_PATH = join(
  process.cwd(),
  "temporal-campaign-log.json"
);

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function breakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const age = Date.now() - lockStat.mtimeMs;
    if (age > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // Lock file gone or inaccessible — either way, proceed
  }
  return false;
}

async function acquireLogLock(logPath: string): Promise<() => Promise<void>> {
  const lockPath = `${logPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let staleLockBroken = false;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      // Write PID for diagnostics
      await handle.write(`${process.pid}\n`);
      return async () => {
        try { await handle.close(); } catch { /* already closed */ }
        await rm(lockPath, { force: true });
      };
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        err.code === "EEXIST"
      ) {
        // Try breaking stale lock once
        if (!staleLockBroken) {
          staleLockBroken = await breakStaleLock(lockPath);
          if (staleLockBroken) continue;
        }
        if (Date.now() < deadline) {
          await sleep(LOCK_RETRY_MS);
          continue;
        }
      }
      throw new InvalidCampaignLogError(`Failed to acquire campaign log lock for ${logPath}`);
    }
  }
}

export async function readCampaignLog(
  logPath: string = DEFAULT_LOG_PATH
): Promise<CampaignLog> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw new InvalidCampaignLogError(
      `Failed to read campaign log ${logPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidCampaignLogError(
      `Campaign log ${logPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    return CampaignLogSchema.parse(parsed);
  } catch (err) {
    throw new InvalidCampaignLogError(
      `Campaign log ${logPath} failed schema validation: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function appendRun(
  logPath: string = DEFAULT_LOG_PATH,
  run: CampaignRun
): Promise<void> {
  CampaignRunSchema.parse(run);
  const releaseLock = await acquireLogLock(logPath);
  try {
    const existing = await readCampaignLog(logPath);
    existing.push(run);
    const tempPath = `${logPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(existing, null, 2), "utf-8");
    await rename(tempPath, logPath);
  } finally {
    await releaseLock();
  }
}
