/**
 * WhatsApp adapter — Twilio Cloud API.
 *
 * SCAFFOLD ONLY. Wiring deferred until:
 *   1. Twilio SDK added (npm install twilio)
 *   2. Env vars configured (TWILIO_ACCOUNT_SID, AUTH_TOKEN, WHATSAPP_FROM)
 *   3. Templates pre-approved in Meta Business Manager
 *
 * The adapter throws SurfaceNotConfiguredError on any send until those land.
 * Domain code can already import and reference `whatsappAdapter` — we just
 * can't deliver through it yet. The shape is locked so the swap is mechanical.
 */

import {
  type OutboundContent,
  type SendResult,
  type SurfaceAdapter,
  SurfaceNotConfiguredError,
} from '../types.js';

export const whatsappAdapter: SurfaceAdapter = {
  name: 'whatsapp',

  async send(_externalId: string, _content: OutboundContent): Promise<SendResult> {
    throw new SurfaceNotConfiguredError('whatsapp');
  },

  async sendTemplate(
    _externalId: string,
    _templateName: string,
    _params: string[],
  ): Promise<SendResult> {
    throw new SurfaceNotConfiguredError('whatsapp');
  },
};
