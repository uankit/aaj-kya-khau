/**
 * Email delivery abstraction.
 *
 * Production: posts to Resend's HTTP API (no SDK — keeps dependency
 * count tight; one fetch call covers our needs).
 * Development: logs the email to stdout. Useful for testing the magic-link
 * flow without configuring Resend / verifying a domain.
 */

import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('email');

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback for clients that prefer it. */
  text?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    log.info(`[DEV EMAIL] (set RESEND_API_KEY to send for real)`);
    log.info(`  to: ${input.to}`);
    log.info(`  subject: ${input.subject}`);
    log.info(`  body:\n${input.text ?? input.html}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error(`Resend send failed (${res.status}): ${body}`);
    throw new Error(`Email send failed: ${res.status}`);
  }

  log.info(`✓ email sent to ${input.to} (subject="${input.subject}")`);
}
