import { z } from "zod";
import { ConfigurationError } from "./errors";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9003;

const EnvSchema = z.object({
  BUPAYMENT_APP_ID: z.string().trim().min(1),
  BUPAYMENT_KEY_ID: z.string().trim().min(1),
  BUPAYMENT_SECRET: z.string().trim().min(1),
  BUPAYMENT_API_BASE_URL: z.string().trim().min(1),
  HOST: z.string().trim().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
});

export type Env = z.infer<typeof EnvSchema>;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function parseEnv(source: EnvSource = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  throw new ConfigurationError(`Environment is not usable: ${summarize(result.error, source)}`);
}

function summarize(error: z.ZodError, source: EnvSource): string {
  const problems = new Map<string, string>();
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? "environment");
    problems.set(name, isBlank(source[name]) ? "missing" : "invalid");
  }
  return [...problems]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, reason]) => `${name} is ${reason}`)
    .join("; ");
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
