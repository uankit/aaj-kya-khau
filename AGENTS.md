# Aaj Kya Khaun — Developer Notes

WhatsApp food assistant agent. Parses grocery invoice PDFs, tracks inventory,
sends meal-time nudges, and suggests what to eat based on what's actually in
your kitchen.

## Architecture at a glance

- **Deterministic onboarding, agentic conversation.** New users go through a
  scripted flow (name → diet → meal times). Once `users.onboarding_complete`
  flips to true, all future messages go to the LLM agent with tool calls.
- **Stack:** TypeScript + Fastify + Drizzle ORM + PostgreSQL + Twilio WhatsApp
  + Vercel AI SDK (`ai` package) for provider-agnostic LLM access.
- **Scheduling:** `node-cron` per-user cron entries. No polling. On boot we
  reload all enabled schedules from the DB and register them.
- **LLM provider is env-driven:** set `LLM_PROVIDER` and `LLM_MODEL` in `.env`.
  Swap between Anthropic / OpenAI / Google / Ollama with zero code changes.

## Key directories

```
src/
├── config/       env validation, DB connection
├── db/           Drizzle schema, migrations, migrate runner
├── onboarding/   scripted state machine (no LLM)
├── agent/        LLM agent loop (Phase 2+)
├── llm/          Vercel AI SDK provider registry
├── services/     whatsapp, user, scheduler, invoice (Phase 2+), etc.
├── routes/       Fastify routes (webhook, health)
├── utils/        logger, time helpers
└── index.ts      app entry: boot → load crons → listen
```

## Conventions

- **ES modules.** All imports use `.js` extensions even for `.ts` sources
  (`import x from './foo.js'`). Required by `moduleResolution: "bundler"`.
- **Env access goes through `src/config/env.ts`** which Zod-validates on boot.
  Never `process.env.FOO` directly.
- **Tool calls always go through Zod schemas.** The agent's tools module
  defines each tool with input validation so a malformed LLM call can't
  corrupt the DB.
- **Logger:** use `createLogger('namespace')` from `src/utils/logger.ts` for
  non-Fastify code. Inside routes, use `request.log`.

## Implementation phases

- **Phase 1 (done):** foundation + onboarding + scheduler skeleton.
- **Phase 2 (done):** agent core + inventory tools + PDF → LLM pipeline.
- **Phase 3 (done):** meal nudges wired to agent + schedule/diet change tools.
- **Phase 4 (done):** nightly summary + nightly cron + `set_nightly_time` tool.

See `/Users/uankit/.Codex/plans/lexical-wiggling-grove.md` for the full spec.

## Running locally

```bash
npm install
cp .env.example .env   # fill in Twilio + LLM creds + DATABASE_URL
npm run db:generate    # generate SQL migration from schema.ts
npm run db:migrate     # apply to your Postgres DB
npm run dev            # starts Fastify on $PORT
```

Use Twilio's WhatsApp sandbox for local development — point its webhook at
a tunnel (`ngrok http 3000`) pointing at `/webhook/whatsapp`.

## Deploying to Railway

1. Push the repo to GitHub.
2. Create a new Railway project → "Deploy from GitHub repo".
3. Add a **Postgres** addon — Railway sets `DATABASE_URL` automatically.
4. Add the other env vars from `.env.example` in Railway's dashboard.
5. Railway runs `npm start` which expects a pre-built `dist/`, so set the
   build command to `npm install && npm run build` and the start command to
   `npm run db:migrate && node dist/index.js`.
6. Copy the Railway public URL (something like `your-app.up.railway.app`) and
   set it as `PUBLIC_BASE_URL` in env.
7. Point Twilio's WhatsApp webhook at `https://<PUBLIC_BASE_URL>/webhook/whatsapp`.
