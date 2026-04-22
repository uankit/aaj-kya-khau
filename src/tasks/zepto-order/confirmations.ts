export type ZeptoOrderReplyKind = 'confirm' | 'cancel' | 'select' | 'other';

export interface ZeptoOrderReply {
  kind: ZeptoOrderReplyKind;
  selectionNumber?: number;
}

const CONFIRM_RE = /^(yes|yep|yeah|y|confirm|confirmed|go ahead|order it|place it|do it|haan|ha|han|hmm yes|sure|ok|okay|chalo|kar do|mangwa do|manga do)$/i;
const CANCEL_RE = /^(no|nope|nah|cancel|stop|don't|dont|leave it|rehne do|mat karo)$/i;

export function parseZeptoOrderReply(text: string): ZeptoOrderReply {
  const normalized = text.trim().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
  if (!normalized) return { kind: 'other' };

  const numeric = normalized.match(/^(?:option\s*)?([1-3])$/i);
  if (numeric) {
    return { kind: 'select', selectionNumber: Number(numeric[1]) };
  }

  if (CONFIRM_RE.test(normalized)) return { kind: 'confirm' };
  if (CANCEL_RE.test(normalized)) return { kind: 'cancel' };

  return { kind: 'other' };
}
