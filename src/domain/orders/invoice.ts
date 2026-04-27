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
import { db } from '../../config/database.js';
import { invoices, type Invoice } from '../../db/schema.js';
import { downloadMedia } from '../../services/telegram.js';
import { addItemsBulk, type AddItemInput } from '../../services/inventory.js';
import { model } from '../../llm/client.js';
import { createLogger } from '../../utils/logger.js';

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
  /** Telegram file_id for the document attachment */
  fileId: string;
}): Promise<ParseInvoiceResult> {
  const { userId, fileId } = args;

  // 1. Create the invoice row up front so we have something to link items to
  //    even if parsing fails partway through. We store the file_id as the
  //    media reference; Telegram file_ids are stable per file upload.
  const [invoice] = await db
    .insert(invoices)
    .values({ userId, mediaUrl: fileId, status: 'processing' })
    .returning();
  const invoiceId = invoice!.id;

  try {
    // 2. Download PDF bytes from Telegram's file CDN
    const buffer = await downloadMedia(fileId);
    log.debug(`Downloaded PDF (${buffer.length} bytes) for user ${userId}`);

    // 3. Extract text
    const parsed = await pdfParse(buffer);
    const rawText: string = parsed.text ?? '';
    if (rawText.trim().length === 0) {
      await markInvoiceFailed(invoiceId, 'Empty PDF text');
      return { invoiceId, itemCount: 0, items: [] };
    }

    // 4. Ask the LLM to return a structured item list.
    //    30k characters is roughly ~7.5k tokens — well within gpt-4o's 128k
    //    context and generous for even long grocery invoices. Anything longer
    //    gets truncated with a log so we know when items might be missed.
    const MAX_PDF_CHARS = 30_000;
    const truncated = rawText.length > MAX_PDF_CHARS;
    if (truncated) {
      log.warn(
        `PDF text is ${rawText.length} chars, truncating to ${MAX_PDF_CHARS} — some items may be missed (invoice ${invoiceId})`,
      );
    }
    const promptText = rawText.slice(0, MAX_PDF_CHARS);

    const { object } = await generateObject({
      model,
      schema: parseSchema,
      system: INVOICE_SYSTEM_PROMPT,
      prompt: `Extract grocery items from this invoice text:\n\n${promptText}`,
      abortSignal: AbortSignal.timeout(45_000),
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

    // Use the actual inserted/updated count, not the input count.
    // addItemsBulk dedupes by normalized_name within a batch, so if the
    // LLM returned "milk" twice we'd only get one row. Reporting the
    // wrong count would mislead the user.
    const persisted = await addItemsBulk(inputs);
    const finalCount = persisted.length;

    await db
      .update(invoices)
      .set({
        status: 'completed',
        rawText: rawText.slice(0, MAX_PDF_CHARS),
        parsedItems: object.items,
        itemCount: finalCount,
      })
      .where(eq(invoices.id, invoiceId));

    log.info(`Parsed invoice ${invoiceId} — ${finalCount} items added (${inputs.length} candidates from LLM)`);

    // Return the preview list from persisted rows (not inputs) so the
    // count and the preview agree — if the LLM returned duplicates, the
    // persisted list has them deduped and the user's summary message
    // won't lie to them.
    return {
      invoiceId,
      itemCount: finalCount,
      items: persisted.map((row) => ({
        rawName: row.rawName ?? '',
        normalizedName: row.normalizedName,
        category: row.category ?? '',
        quantity: row.quantity ?? null,
        confidence: row.confidence,
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
