import { generateObject } from 'ai';
import { z } from 'zod';
import { fastModel } from '../../llm/client.js';
import { callZeptoTool, type McpToolResult } from '../../services/mcp/zepto-client.js';
import { getValidZeptoAccessToken } from '../../services/mcp/zepto-account.js';
import {
  getActiveZeptoOrderTask,
  updateZeptoOrderTaskState,
  type ZeptoProductOption,
  type ZeptoToolRef,
} from '../agent-task-store.js';
import { createLogger } from '../../utils/logger.js';
import { escapeHtml } from '../../utils/html.js';

const log = createLogger('zepto-workflow');

const ARG_BUILD_TIMEOUT_MS = 8_000;
const TOOL_RESULT_MAX_CHARS = 1200;

const ArgsSchema = z.object({
  args: z.record(z.unknown()),
});

export interface WorkflowReply {
  text: string;
  completed?: boolean;
}

function flattenMcpContent(r: McpToolResult): string {
  if (!r.content || r.content.length === 0) return JSON.stringify(r);
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

function summarizeToolResult(r: McpToolResult): string {
  const text = flattenMcpContent(r);
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n...[truncated]`
    : text;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function aliasesFor(prop: string): string[] {
  const n = normalizedKey(prop);
  const out = new Set<string>([prop, n]);
  if (n.includes('variant')) {
    out.add('variantId');
    out.add('variant_id');
    out.add('productVariantId');
    out.add('skuId');
    out.add('id');
  }
  if (n.includes('product')) {
    out.add('productId');
    out.add('product_id');
    out.add('product_id_string');
    out.add('id');
  }
  if (n.includes('sku')) {
    out.add('skuId');
    out.add('sku_id');
    out.add('id');
  }
  if (n.includes('quantity') || n === 'qty') {
    out.add('quantity');
    out.add('qty');
  }
  return [...out];
}

function findValueDeep(raw: unknown, aliases: string[]): unknown {
  const aliasSet = new Set(aliases.map(normalizedKey));
  const seen = new Set<unknown>();
  const stack: unknown[] = [raw];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (aliasSet.has(normalizedKey(key)) && value !== null && value !== undefined) return value;
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return undefined;
}

function schemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  const resolved = schema as Record<string, unknown>;
  if (resolved.properties && typeof resolved.properties === 'object') return resolved;
  const params = resolved.parameters;
  if (params && typeof params === 'object') return params as Record<string, unknown>;
  return resolved;
}

function deterministicArgs(
  schema: Record<string, unknown>,
  rawProduct: unknown,
): Record<string, unknown> | null {
  const root = schemaObject(schema);
  const properties =
    root.properties && typeof root.properties === 'object'
      ? (root.properties as Record<string, Record<string, unknown>>)
      : null;
  if (!properties) return rawProduct && typeof rawProduct === 'object' ? rawProduct as Record<string, unknown> : null;

  const required = Array.isArray(root.required) ? root.required.map(String) : [];
  const out: Record<string, unknown> = {};

  for (const [prop, propSchema] of Object.entries(properties)) {
    let value = findValueDeep(rawProduct, aliasesFor(prop));
    const type = propSchema?.type;

    if (value === undefined && (prop === 'quantity' || prop === 'qty' || normalizedKey(prop).includes('quantity'))) {
      value = 1;
    }
    if (value === undefined) continue;

    if (type === 'integer' || type === 'number') {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(num)) out[prop] = num;
      continue;
    }
    if (type === 'string') {
      out[prop] = String(value);
      continue;
    }
    out[prop] = value;
  }

  const missing = required.filter((key) => out[key] === undefined);
  return missing.length === 0 ? out : null;
}

async function llmBuildArgs(
  tool: ZeptoToolRef,
  product: ZeptoProductOption,
): Promise<Record<string, unknown> | null> {
  try {
    const { object } = await generateObject({
      model: fastModel,
      schema: ArgsSchema,
      system:
        'Build JSON arguments for a grocery add-to-cart tool. Use only fields present in the product/search object. Do not invent ids. If quantity is required and absent, use 1.',
      prompt: `Tool name: ${tool.name}
Input JSON schema:
${JSON.stringify(tool.inputSchema)}

Selected product:
${JSON.stringify(product.raw)}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(ARG_BUILD_TIMEOUT_MS),
    });
    return object.args;
  } catch (err) {
    log.warn('LLM add-to-cart argument build failed', err);
    return null;
  }
}

function productLine(product: ZeptoProductOption): string {
  return [
    `<b>${escapeHtml(product.title)}</b>`,
    product.subtitle ? escapeHtml(product.subtitle) : null,
    product.price ? `<b>${escapeHtml(product.price)}</b>` : null,
    product.eta ? `<b>${escapeHtml(product.eta)}</b>` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export async function selectZeptoOrderOption(
  userId: string,
  optionNumber: number,
): Promise<WorkflowReply> {
  const task = await getActiveZeptoOrderTask(userId);
  if (!task) {
    return { text: 'That Zepto flow expired. Search again?' };
  }

  const product = task.state.productOptions?.find((p) => p.optionNumber === optionNumber);
  if (!product) {
    return { text: `I only have ${task.state.productOptions?.length ?? 0} options here. Pick one of those, or search again.` };
  }

  const addTool = task.state.addToCartTool;
  if (!addTool) {
    return { text: "I can show Zepto options, but I couldn't find a safe add-to-cart tool. Try reconnecting Zepto?" };
  }

  const args =
    deterministicArgs(addTool.inputSchema, product.raw) ?? (await llmBuildArgs(addTool, product));
  if (!args || Object.keys(args).length === 0) {
    return {
      text:
        "I found the item, but Zepto didn't give me enough structured product data to safely order it. Search another option?",
    };
  }

  await updateZeptoOrderTaskState({
    userId,
    status: 'waiting_user',
    patch: {
      phase: 'awaiting_confirmation',
      selectedOptionNumber: optionNumber,
      selectedProduct: product,
      addToCartArgs: args,
      updatedReason: 'selected_product',
    },
  });

  return {
    text: `Selected:\n${productLine(product)}\n\nConfirm COD order?`,
  };
}

function formatCheckoutResult(result: string): string {
  return result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 900);
}

export async function confirmZeptoOrder(userId: string): Promise<WorkflowReply> {
  const task = await getActiveZeptoOrderTask(userId);
  if (!task) return { text: 'That Zepto order flow expired. Search again?' };

  const { selectedProduct, addToCartTool, checkoutTool, addToCartArgs } = task.state;
  if (!selectedProduct || !addToCartTool || !checkoutTool || !addToCartArgs) {
    return { text: 'Pick an option first, then I can place the order safely.' };
  }

  const token = await getValidZeptoAccessToken(userId);
  if (!token) return { text: 'Your Zepto connection expired. Please run /connect_zepto again.' };

  await updateZeptoOrderTaskState({
    userId,
    status: 'active',
    patch: { updatedReason: 'placing_order' },
  });

  const cart = await callZeptoTool(token, addToCartTool.name, addToCartArgs);
  const cartSummary = summarizeToolResult(cart);
  if (cart.isError) {
    await updateZeptoOrderTaskState({
      userId,
      status: 'failed',
      patch: { cartResult: cartSummary, updatedReason: 'cart_failed' },
    });
    return { text: `Zepto couldn't add that to cart:\n${formatCheckoutResult(cartSummary)}` };
  }

  await updateZeptoOrderTaskState({
    userId,
    status: 'active',
    patch: { phase: 'cart_staged', cartResult: cartSummary, updatedReason: 'cart_staged' },
  });

  const checkoutArgs = deterministicArgs(checkoutTool.inputSchema, {
    paymentMethod: 'COD',
    payment_mode: 'COD',
    paymentMode: 'COD',
    cod: true,
  }) ?? {};
  const checkout = await callZeptoTool(token, checkoutTool.name, checkoutArgs);
  const checkoutSummary = summarizeToolResult(checkout);

  await updateZeptoOrderTaskState({
    userId,
    status: checkout.isError ? 'failed' : 'completed',
    patch: {
      phase: 'checkout_attempted',
      checkoutResult: checkoutSummary,
      updatedReason: checkout.isError ? 'checkout_failed' : 'checkout_completed',
    },
  });

  if (checkout.isError) {
    return { text: `Zepto couldn't place the order:\n${formatCheckoutResult(checkoutSummary)}` };
  }

  return {
    completed: true,
    text: `<b>Order placed</b> ✅\n\n${productLine(selectedProduct)}\n\n${formatCheckoutResult(checkoutSummary)}\n\nTell me when it arrives and I'll add it to your kitchen.`,
  };
}
