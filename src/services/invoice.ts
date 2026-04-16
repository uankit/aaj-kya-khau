/**
 * PDF invoice → inventory pipeline.
 *
 * Strategy: extract text from the PDF with `pdf-parse`, then hand the text to
 * the LLM and ask it to return a structured list of items (Zod-validated via
 * `generateObject`). This works with any provider (Anthropic, OpenAI, Google,
 * or local Ollama) — no vision / file-input dependency.
 *
 * We skip the regex/normalizer/curated-lookup approach entirely. Modern LLMs
 * handle messy invoice text (especially Indian grocery apps) very well, and
 * we save ourselves hundreds of lines of brittle string-munging code.
 */

import { z } from 'zod';
import { generateObject } from 'ai';
// Import directly from the lib file to avoid pdf-parse's debug test-file read
// on module load (a well-known ESM issue with pdf-parse@1.1.x).
// @ts-expect-error — no types on the deep import path
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices, type Invoice } from '../db/schema.js';
import { downloadMedia } from './whatsapp.js';
import { addItemsBulk, type AddItemInput } from './inventory.js';
import { model } from '../llm/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('invoice');

/** Zod schema the LLM must return. */
const parsedItemSchema = z.object({
  raw_name: z.string().describe('The exact name as it appears on the invoice'),
  normalized_name: z
    .string()
    .describe(
      "A short, common name like 'milk', 'paneer', 'bread', 'eggs', 'atta', 'rice'. Lowercase. Brand stripped.",
    ),
  category: z
    .string()
    .describe("e.g. 'dairy', 'vegetable', 'fruit', 'grain', 'pulses', 'snack', 'spice', 'beverage'"),
  quantity: z
    .string()
    .nullable()
    .describe("e.g. '1L', '500g', '12 pcs', or null if unknown"),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('How confident you are that this is a real food/grocery item'),
});

const parseSchema = z.object({
  items: z.array(parsedItemSchema),
});

const INVOICE_SYSTEM_PROMPT = `You are an expert at reading Indian grocery invoices (BigBasket, Blinkit, Zepto, Instamart, JioMart, etc.).

You will be given raw text extracted from a PDF invoice. Your job:

1. Identify the actual food / grocery line items the user bought
2. Return a JSON list matching the provided schema
3. STRIP brand names from the normalized_name ('Amul Taaza Toned Milk 1L' → 'milk')
4. Normalize to common Indian grocery item names (use short lowercase words)
5. Merge variants: 'toor dal' and 'arhar dal' are both 'toor dal'; 'curd' and 'dahi' are both 'curd'
6. IGNORE: taxes, GST, CGST, SGST, delivery fees, handling charges, tips, discounts, subtotals, grand totals, order IDs, addresses, phone numbers, payment method, coupon codes, refunds, and any non-food items (utensils, cleaning supplies, personal care unless asked)
7. If you genuinely can't tell if something is food, use confidence: 'low'
8. If the text is clearly not an invoice or has no recognizable grocery items, return an empty items array

Be strict about #6 — we only want ingredients that go into meals.`;

export interface ParseInvoiceResult {
  invoiceId: string;
  itemCount: number;
  items: Array<{
    rawName: string;
    normalizedName: string;
    category: string;
    quantity: string | null;
    confidence: 'high' | 'medium' | 'low';
  }>;
}

/**
 * Full pipeline: download the PDF, extract text, LLM-parse, persist invoice
 * and inventory rows. Returns the resulting items so the agent can summarize
 * them to the user.
 */
export async function parseAndSaveInvoice(args: {
  userId: string;
  mediaUrl: string;
}): Promise<ParseInvoiceResult> {
  const { userId, mediaUrl } = args;

  // 1. Create the invoice row up front so we have something to link items to
  //    even if parsing fails partway through.
  const [invoice] = await db
    .insert(invoices)
    .values({ userId, mediaUrl, status: 'processing' })
    .returning();
  const invoiceId = invoice!.id;

  try {
    // 2. Download PDF bytes from Twilio
    const buffer = await downloadMedia(mediaUrl);
    log.debug(`Downloaded PDF (${buffer.length} bytes) for user ${userId}`);

    // 3. Extract text
    const parsed = await pdfParse(buffer);
    const rawText: string = parsed.text ?? '';
    if (rawText.trim().length === 0) {
      await markInvoiceFailed(invoiceId, 'Empty PDF text');
      return { invoiceId, itemCount: 0, items: [] };
    }

    // 4. Ask the LLM to return a structured item list
    const { object } = await generateObject({
      model,
      schema: parseSchema,
      system: INVOICE_SYSTEM_PROMPT,
      prompt: `Extract grocery items from this invoice text:\n\n${rawText.slice(0, 15000)}`,
    });

    // 5. Upsert into inventory (skip any low-confidence items with an empty name)
    const inputs: AddItemInput[] = object.items
      .filter((it) => it.normalized_name.trim().length > 0)
      .map((it) => ({
        userId,
        normalizedName: it.normalized_name,
        rawName: it.raw_name,
        category: it.category,
        quantity: it.quantity ?? undefined,
        source: 'invoice' as const,
        invoiceId,
        confidence: it.confidence,
      }));

    await addItemsBulk(inputs);

    await db
      .update(invoices)
      .set({
        status: 'completed',
        rawText: rawText.slice(0, 50_000),
        parsedItems: object.items,
        itemCount: inputs.length,
      })
      .where(eq(invoices.id, invoiceId));

    log.info(`Parsed invoice ${invoiceId} — ${inputs.length} items added`);

    return {
      invoiceId,
      itemCount: inputs.length,
      items: inputs.map((it) => ({
        rawName: it.rawName ?? '',
        normalizedName: it.normalizedName,
        category: it.category ?? '',
        quantity: it.quantity ?? null,
        confidence: it.confidence ?? 'high',
      })),
    };
  } catch (err) {
    log.error(`Invoice parse failed for ${invoiceId}`, err);
    await markInvoiceFailed(invoiceId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function markInvoiceFailed(invoiceId: string, reason: string): Promise<void> {
  await db
    .update(invoices)
    .set({ status: 'failed', rawText: reason })
    .where(eq(invoices.id, invoiceId));
}

/** Exposed for diagnostics / the /health endpoint later. */
export async function getInvoice(invoiceId: string): Promise<Invoice | null> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return rows[0] ?? null;
}
