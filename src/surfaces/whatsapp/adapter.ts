/**
 * WhatsApp adapter — Twilio Cloud API.
 *
 * send()         — freeform body. Works inside the 24-hour session window.
 *                  Outside it, Twilio returns error code 63016 ("freeform
 *                  message can't be sent outside session"); the deliver()
 *                  router upgrades to sendTemplate when that policy bites.
 *
 * sendTemplate() — contentSid + contentVariables. Required for any
 *                  proactive send outside the 24-hour window. Templates
 *                  are pre-approved in Meta Business Manager and mapped
 *                  to logical names in templates.ts.
 *
 * Errors are translated into SurfaceError with a stable code field so
 * upstream policy layers (window detection, retry) can reason about them
 * without parsing Twilio's strings.
 */

import { createLogger } from '../../utils/logger.js';
import {
  type OutboundContent,
  type SendResult,
  SurfaceError,
  type SurfaceAdapter,
} from '../types.js';
import { asWhatsAppAddress, getTwilioClient, whatsAppFrom } from './client.js';
import { buildContentVariables, resolveTemplateSid } from './templates.js';

const log = createLogger('surface-whatsapp');

const TWILIO_OUTSIDE_SESSION_CODE = 63016;

function renderBody(content: OutboundContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'choice': {
      const lines = content.options.map((opt, i) => `${i + 1}. ${opt}`);
      return `${content.text}\n\n${lines.join('\n')}\n\nReply with the number.`;
    }
    case 'confirm':
      return `${content.text}\n\nReply *yes* to confirm or *no* to cancel.`;
  }
}

export const whatsappAdapter: SurfaceAdapter = {
  name: 'whatsapp',

  async send(externalId, content): Promise<SendResult> {
    const client = getTwilioClient();
    const to = asWhatsAppAddress(externalId);
    const body = renderBody(content);
    log.info(`→ wa send to ${externalId}`, { chars: body.length, kind: content.kind });
    try {
      const msg = await client.messages.create({
        from: whatsAppFrom(),
        to,
        body,
      });
      log.info(`✓ wa sent`, { externalId, sid: msg.sid });
      return { messageId: msg.sid };
    } catch (err) {
      throw translateTwilioError(err, externalId, 'send');
    }
  },

  async sendTemplate(externalId, templateName, params): Promise<SendResult> {
    const client = getTwilioClient();
    const to = asWhatsAppAddress(externalId);
    const contentSid = resolveTemplateSid(templateName);
    const contentVariables = buildContentVariables(params);
    log.info(`→ wa template send to ${externalId}`, { templateName, paramCount: params.length });
    try {
      const msg = await client.messages.create({
        from: whatsAppFrom(),
        to,
        contentSid,
        contentVariables,
      });
      log.info(`✓ wa template sent`, { externalId, sid: msg.sid, templateName });
      return { messageId: msg.sid };
    } catch (err) {
      throw translateTwilioError(err, externalId, `template:${templateName}`);
    }
  },
};

function translateTwilioError(err: unknown, externalId: string, op: string): SurfaceError {
  const e = err as { code?: number; status?: number; message?: string };
  const code = e.code;
  const msg = e.message ?? String(err);
  log.error(`✗ wa ${op} to ${externalId} failed (code=${code})`, err);
  if (code === TWILIO_OUTSIDE_SESSION_CODE) {
    return new SurfaceError(
      'WhatsApp 24-hour session window expired; template required',
      'whatsapp',
      'outside_session_window',
    );
  }
  return new SurfaceError(`twilio: ${msg}`, 'whatsapp', `twilio_${code ?? 'unknown'}`);
}
