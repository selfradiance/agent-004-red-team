import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

export const DEFAULT_LOG_PATH = join(
  process.cwd(),
  "temporal-campaign-log.json"
);

export async function readCampaignLog(
  logPath: string = DEFAULT_LOG_PATH
): Promise<CampaignLog> {
  if (!existsSync(logPath)) {
    return [];
  }
  const raw = await readFile(logPath, "utf-8");
  const parsed = JSON.parse(raw);
  return CampaignLogSchema.parse(parsed);
}

export async function appendRun(
  logPath: string = DEFAULT_LOG_PATH,
  run: CampaignRun
): Promise<void> {
  CampaignRunSchema.parse(run);
  const existing = await readCampaignLog(logPath);
  existing.push(run);
  await writeFile(logPath, JSON.stringify(existing, null, 2), "utf-8");
}
