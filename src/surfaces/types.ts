/**
 * SurfaceAdapter — the abstraction every chat transport
 * implements for OUTBOUND messages. Domain code (scheduler, agent, workflows)
 * emits provider-agnostic OutboundContent and the adapter lowers it into the
 * surface's native shape (Telegram inline keyboards, etc.).
 *
 * Inbound parsing stays surface-specific for now — webhook formats diverge
 * too much to be worth abstracting before another surface is wired.
 */

/** Live chat surfaces. Add new entries once their adapter ships. */
export type SurfaceName = 'telegram';

/** Surface-agnostic outbound message. Adapters lower into native form. */
export type OutboundContent =
  /** Plain text — surface chooses formatting (HTML on Telegram, markdown-ish on WA). */
  | { kind: 'text'; text: string }
  /** Numbered options the user picks by replying "1", "2", "3". */
  | { kind: 'choice'; text: string; options: string[] }
  /** Single yes/no decision. Telegram renders inline buttons; WA renders text. */
  | { kind: 'confirm'; text: string };

export interface SendResult {
  messageId: string;
}

export interface SurfaceAdapter {
  readonly name: SurfaceName;

  /**
   * Send freeform content to a user identified by their external surface ID
   * (Telegram chat_id today; future surfaces will define their own).
   */
  send(externalId: string, content: OutboundContent): Promise<SendResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────

export class SurfaceError extends Error {
  constructor(
    message: string,
    public readonly surface: SurfaceName,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SurfaceError';
  }
}

export class SurfaceNotConfiguredError extends SurfaceError {
  constructor(surface: SurfaceName) {
    super(`${surface} surface is not configured`, surface, 'not_configured');
    this.name = 'SurfaceNotConfiguredError';
  }
}
