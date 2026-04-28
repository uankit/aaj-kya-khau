/**
 * Welcome email — fired once when the user successfully binds Telegram
 * for the first time (consumeBindToken returns fresh=true).
 *
 * Tone: product-first. Two boxes describing the two flows the user can
 * actually use ("pick a meal from your pantry" / "order what's missing"),
 * one example each, single CTA. No command dumps, no "tip & tricks" list.
 */

import type { User } from '../../db/schema.js';
import { sendEmail } from '../email.js';

export interface WelcomeOpts {
  /** Where the "Open chat" button should land. */
  openChatUrl: string;
}

export async function sendWelcomeEmail(user: User, opts: WelcomeOpts): Promise<void> {
  if (!user.email) return;
  const firstName = (user.name ?? '').trim().split(/\s+/)[0] || 'there';
  const subject = `Welcome to Aaj Kya Khaun.`;
  const html = renderHtml(firstName, opts.openChatUrl);
  const text = renderText(firstName, opts.openChatUrl);
  await sendEmail({ to: user.email, subject, html, text });
}

// ─────────────────────────────────────────────────────────────────────────
// Templates. Inline styles only — most email clients strip <style> blocks.
// Palette mirrors public/styles.css so brand stays consistent.
// ─────────────────────────────────────────────────────────────────────────

const COLORS = {
  cream: '#FEF6E4',
  cream2: '#FFFBF0',
  ink: '#001858',
  text: '#001858',
  textMuted: '#6B7C93',
  coral: '#F582AE',
  coralDeep: '#E85A89',
  white: '#FFFFFE',
  border: 'rgba(23, 44, 102, 0.08)',
};

const FONT_BODY = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
const FONT_DISPLAY = `'Bricolage Grotesque', 'Inter', -apple-system, sans-serif`;

function renderHtml(name: string, openChatUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Aaj Kya Khaun</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:${FONT_BODY};color:${COLORS.text};-webkit-font-smoothing:antialiased;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px 48px;">

    <!-- Logo / wordmark -->
    <div style="margin-bottom:28px;font-family:${FONT_DISPLAY};font-weight:700;font-size:18px;color:${COLORS.ink};">
      🍽️ Aaj Kya Khaun
    </div>

    <!-- Hero -->
    <h1 style="font-family:${FONT_DISPLAY};font-weight:700;font-size:30px;line-height:1.15;letter-spacing:-0.02em;margin:0 0 12px;color:${COLORS.ink};">
      Hi ${escapeHtml(name)} 👋
    </h1>
    <p style="font-size:16px;line-height:1.55;margin:0 0 28px;color:${COLORS.textMuted};">
      Your kitchen knows what's in it. So when you ask <em>"what should I eat tonight?"</em>, the answer is grounded in your pantry — not a generic recipe blog.
    </p>

    <!-- Two flows -->
    <div style="background:${COLORS.white};border:1px solid ${COLORS.border};border-radius:20px;padding:24px;margin-bottom:14px;">
      <div style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};margin-bottom:8px;">
        Pick a meal from what you have
      </div>
      <div style="font-family:${FONT_DISPLAY};font-weight:700;font-size:20px;color:${COLORS.ink};margin-bottom:8px;">
        "I'm hungry"
      </div>
      <div style="font-size:15px;line-height:1.5;color:${COLORS.text};">
        Tell me you're hungry. If your pantry has rice, dal, and onions — you're getting khichdi. Not a recipe that needs three things you don't own.
      </div>
    </div>

    <div style="background:${COLORS.white};border:1px solid ${COLORS.border};border-radius:20px;padding:24px;margin-bottom:28px;">
      <div style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};margin-bottom:8px;">
        Order only what's missing
      </div>
      <div style="font-family:${FONT_DISPLAY};font-weight:700;font-size:20px;color:${COLORS.ink};margin-bottom:8px;">
        "I want pasta tonight"
      </div>
      <div style="font-size:15px;line-height:1.5;color:${COLORS.text};">
        I check what you've got. Garlic and tomato are there but pasta isn't, so I order just the pasta on Zepto. 10-minute delivery, COD.
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px;">
      <a href="${escapeAttr(openChatUrl)}"
         style="display:inline-block;padding:14px 28px;background:${COLORS.ink};color:${COLORS.white};text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;">
        Open chat →
      </a>
    </div>

    <!-- Trust -->
    <p style="font-size:14px;line-height:1.55;color:${COLORS.textMuted};margin:0 0 32px;">
      I won't ping you out of the blue. Only at the meal times you set.
    </p>

    <!-- Footer -->
    <hr style="border:none;border-top:1px solid ${COLORS.border};margin:32px 0;" />
    <div style="font-size:12px;line-height:1.55;color:${COLORS.textMuted};">
      Sent because you signed up at aajkyakhaun.com.<br />
      Reply to this email if anything's off — a real human reads it.
    </div>

  </div>
</body>
</html>`;
}

function renderText(name: string, openChatUrl: string): string {
  return `Hi ${name},

Your kitchen knows what's in it. So when you ask "what should I eat tonight?", the answer is grounded in your pantry — not a generic recipe blog.

Two things you can do:

1) Pick a meal from what you have.
   Tell me you're hungry. If your pantry has rice, dal, and onions — you're getting khichdi. Not a recipe that needs three things you don't own.

2) Order only what's missing.
   "I want pasta tonight." I check what you've got. Garlic and tomato are there but pasta isn't, so I order just the pasta on Zepto. 10-minute delivery, COD.

Open chat: ${openChatUrl}

I won't ping you out of the blue. Only at the meal times you set.

—
Aaj Kya Khaun
Reply to this email if anything's off.
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
