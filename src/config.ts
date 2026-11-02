import { z } from 'zod';

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // "api" serves HTTP only, "worker" consumes SQS only, "all" runs both in one process.
  MODE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),

  AWS_REGION: z.string().min(1),
  // Optional: AWS SDK also reads these from the standard env vars / instance role.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  SQS_QUEUE_URL: z.string().min(1),
  // Local dev with ElasticMQ / LocalStack.
  SQS_ENDPOINT: z.string().optional(),
  SQS_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  MAX_SEND_ATTEMPTS: z.coerce.number().int().min(1).default(5),

  // When true, the worker logs the email instead of calling SES. Useful locally.
  SES_DRY_RUN: boolish.default('false'),
  // Prefix for per-project SES configuration sets, e.g. "emailsvc-<slug>".
  SES_CONFIG_SET_PREFIX: z.string().default('emailsvc'),
  // SNS topic that SES event destinations publish to. Set after `npm run setup:aws`.
  SNS_EVENTS_TOPIC_ARN: z.string().optional(),

  // Bearer token for /admin routes (project + key + domain management).
  ADMIN_TOKEN: z.string().min(16),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function configSetName(cfg: Config, projectSlug: string): string {
  return `${cfg.SES_CONFIG_SET_PREFIX}-${projectSlug}`;
}
