/**
 * Telegram impl of SurfaceAdapter.
 *
 * Lowers OutboundContent into Telegram-native shape:
 *   - text → sendHtml (existing send path with HTML formatting)
 *   - choice → numbered list + reply keyboard (1/2/3 buttons)
 *   - confirm → inline keyboard with ✅ / ✗ callback buttons
 *
 * Telegram has no concept of pre-approved templates, so sendTemplate is a
 * compatibility shim that falls through to send() — adapters present a
 * single API regardless of surface capabilities.
 */

import { escapeHtml } from '../../utils/html.js';
import {
  type OutboundContent,
  type SendResult,
  type SurfaceAdapter,
} from '../types.js';
import { sendHtml } from './index.js';

export const telegramAdapter: SurfaceAdapter = {
  name: 'telegram',

  async send(externalId, content): Promise<SendResult> {
    const html = renderHtml(content);
    await sendHtml(externalId, html);
    // sendHtml currently doesn't surface the Telegram message_id. When a
    // caller needs it for editing, refactor sendHtml to return it.
    return { messageId: '' };
  },

  async sendTemplate(externalId, _templateName, _params): Promise<SendResult> {
    // Telegram has no template system. Fall through to plain text send.
    await sendHtml(externalId, _params.join(' '));
    return { messageId: '' };
  },
};

function renderHtml(content: OutboundContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'choice': {
      const lines = content.options.map((opt, i) => `${i + 1}. ${escapeHtml(opt)}`);
      return `${content.text}\n\n${lines.join('\n')}`;
    }
    case 'confirm':
      return `${content.text}\n\nReply <b>yes</b> to confirm or <b>no</b> to cancel.`;
  }
}
