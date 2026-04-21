import type { FastifyInstance } from 'fastify';
import { getActiveCronCount } from '../services/scheduler.js';
import { getNightlyCronCount } from '../services/nightly.js';

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aaj Kya Khaun — Telegram Food Assistant</title>
  <meta name="description" content="A Telegram food assistant for Indian households. Parses your grocery invoices, tracks your kitchen inventory, and suggests meals based on what you actually have." />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #fef6e4 0%, #f3d2c1 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #001858;
    }
    .container {
      max-width: 600px;
      text-align: center;
      padding: 40px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.08);
    }
    .emoji { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 36px; margin-bottom: 8px; color: #001858; }
    .tagline { font-size: 18px; color: #8bd3dd; margin-bottom: 24px; font-weight: 500; }
    p { font-size: 16px; line-height: 1.6; margin-bottom: 16px; color: #172c66; }
    .features {
      text-align: left;
      margin: 24px 0;
      padding: 20px;
      background: #fef6e4;
      border-radius: 12px;
    }
    .features li { list-style: none; padding: 8px 0; font-size: 15px; }
    .science {
      margin-top: 24px;
      padding: 16px;
      background: #f3d2c1;
      border-radius: 8px;
      font-size: 13px;
      color: #172c66;
    }
    .science strong { display: block; margin-bottom: 6px; }
    footer { margin-top: 24px; font-size: 13px; color: #8bd3dd; }
  </style>
</head>
<body>
  <div class="container">
    <div class="emoji">🍽️</div>
    <h1>Aaj Kya Khaun</h1>
    <p class="tagline">Your Telegram food assistant</p>
    <p>Drop your grocery invoices. Track your kitchen inventory. Get meal suggestions based on what you actually have — not generic recipes from the internet.</p>
    <ul class="features">
      <li>📄 <strong>Invoice parsing</strong> — PDFs from Blinkit, Zepto, BigBasket auto-build your inventory</li>
      <li>🍴 <strong>Smart suggestions</strong> — meals from what's in your kitchen, not repeats from yesterday</li>
      <li>⏰ <strong>Meal reminders</strong> — gentle nudges at your chosen times</li>
      <li>🔬 <strong>Nutrition tracking</strong> — calorie & macro targets backed by peer-reviewed research</li>
    </ul>
    <div class="science">
      <strong>Science over guesswork</strong>
      Nutrition engine grounded in Mifflin-St Jeor (1990), ICMR-NIN RDA (2020), IFCT 2017 food composition data, and WHO TRS 916.
    </div>
    <footer>Built for Indian households. © 2026</footer>
  </div>
</body>
</html>`;

export async function healthRoutes(app: FastifyInstance) {
  // Public landing page at root — useful for link-preview on LinkedIn, etc.
  // (Meta's crawler checks the listed business website exists).
  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(LANDING_HTML);
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      mealCrons: getActiveCronCount(),
      nightlyCrons: getNightlyCronCount(),
    };
  });
}
