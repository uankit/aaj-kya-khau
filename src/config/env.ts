import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment variable schema. All env access in the app goes through `env` below,
 * so if something is missing at boot we fail loudly instead of surfacing as a
 * cryptic runtime error deep in a request handler.
 */
const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Database
  DATABASE_URL: z.string().url(),

  // Telegram — bot token from @BotFather, webhook secret for incoming request auth
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),

  // LLM
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'google', 'ollama']).default('anthropic'),
  LLM_MODEL: z.string().default('claude-3-5-sonnet-20241022'),
  LLM_FAST_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),

  // Defaults
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),

  // Encryption — 32 bytes base64-encoded (generate: `openssl rand -base64 32`).
  // Required once OAuth integrations are in use; optional for local dev without
  // Zepto/Swiggy wired up. Validated shape if set.
  ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine(
      (v) => !v || Buffer.from(v, 'base64').length === 32,
      'ENCRYPTION_KEY must be 32 bytes base64-encoded',
    ),

  // Zepto MCP OAuth client credentials. Register via
  // `npm run zepto:register-client` after PUBLIC_BASE_URL is set.
  ZEPTO_CLIENT_ID: z.string().optional(),
  ZEPTO_REGISTRATION_ACCESS_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
