/**
 * Provider-agnostic LLM client.
 *
 * Switching providers is a 1-line change in `.env` — no code modifications.
 * Vercel AI SDK exposes a uniform `LanguageModel` interface so the rest of the
 * codebase doesn't care which backend is actually running the model.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createOllama } from 'ollama-ai-provider';
import type { LanguageModel } from 'ai';
import { env } from '../config/env.js';

function buildModel(): LanguageModel {
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      }
      // The SDK reads ANTHROPIC_API_KEY from env automatically.
      return anthropic(env.LLM_MODEL);
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return openai(env.LLM_MODEL);
    case 'google':
      if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new Error('LLM_PROVIDER=google requires GOOGLE_GENERATIVE_AI_API_KEY');
      }
      return google(env.LLM_MODEL);
    case 'ollama': {
      const ollama = createOllama({ baseURL: `${env.OLLAMA_BASE_URL}/api` });
      return ollama(env.LLM_MODEL);
    }
  }
}

/** Singleton model instance. Construction is cheap so a module-level const is fine. */
export const model: LanguageModel = buildModel();

/** True if the active provider supports direct file (PDF/image) inputs. */
export function providerSupportsDirectPdf(): boolean {
  return env.LLM_PROVIDER === 'anthropic' || env.LLM_PROVIDER === 'openai';
}
