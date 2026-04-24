# Aaj Kya Khaun 🍽️

A Telegram food assistant agent for Indian users. Parses grocery invoice PDFs, tracks kitchen inventory, sends meal-time nudges, and suggests meals based on what you actually have — grounded in peer-reviewed nutrition science, not guesswork.

## What it does

- 📄 **Drop grocery bills** (Blinkit / Zepto / BigBasket PDFs) on Telegram → auto-builds kitchen inventory
- 🍴 **"I'm hungry"** → suggests a meal based on actual inventory, diet, and what you ate recently (no repeats)
- ⏰ **Scheduled meal nudges** at your chosen times
- 🌙 **Nightly summary** — recaps meals, asks what's finished
- 🔬 **Nutrition tracking** — grounded in real science (see below), not LLM guesses

## Architecture

- **Deterministic onboarding** (scripted, no LLM) → **agentic conversation** (LLM with tool calls) once onboarded
- **TypeScript + Fastify + Drizzle ORM + PostgreSQL + Telegram Bot API** (via [grammy](https://grammy.dev))
- **Vercel AI SDK** for provider-agnostic LLM access — swap between Anthropic / OpenAI / Google / Ollama via `.env`
- **Per-user cron entries** (no polling) for meal reminders and nightly summary

## Scientific foundation

The nutrition engine is grounded in peer-reviewed research:

| Algorithm | Source |
|---|---|
| BMR estimation | **Mifflin-St Jeor equation** — Am J Clin Nutr 1990;51:241-7 |
| Macronutrient targets | **ICMR-NIN RDA for Indians, 2020** |
| Food composition data | **Indian Food Composition Tables (IFCT) 2017**, NIN Hyderabad |
| Weight management | **WHO Technical Report Series 916**, 2003 |

The LLM handles natural language understanding and personality. The science handles the numbers.

## Running locally

```bash
npm install
cp .env.example .env      # fill in Telegram bot token + LLM creds + DATABASE_URL
createdb aaj_kya_khaun
npm run db:migrate        # apply schema
npm run db:seed           # populate IFCT 2017 food database (~95 items)
npm run dev               # starts Fastify on $PORT
```

Get a bot token from [@BotFather](https://t.me/BotFather) and generate a webhook secret with `openssl rand -hex 32`. Use ngrok (`ngrok http 3000`) to expose your local server, then register the webhook at `https://<ngrok-url>/webhook/telegram`.

## Deploying to Railway

1. Push repo to GitHub.
2. Create Railway project → Deploy from GitHub repo.
3. Add a **Postgres** addon — `DATABASE_URL` is set automatically.
4. Add env vars in Railway dashboard (see `.env.example`) — including `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
5. Railway auto-detects the `railway.json` config.
6. Copy the public Railway URL → set as `PUBLIC_BASE_URL` → register the Telegram webhook at `https://<PUBLIC_BASE_URL>/webhook/telegram`.

Built with [Claude Code](https://claude.com/claude-code).
