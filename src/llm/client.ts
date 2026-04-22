/**
 * Provider-agnostic LLM client.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createOllama } from 'ollama-ai-provider';
import type { LanguageModel } from 'ai';
import { env } from '../config/env.js';

function buildModel(modelName = env.LLM_MODEL): LanguageModel {
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      }
      // The SDK reads ANTHROPIC_API_KEY from env automatically.
      return anthropic(modelName);
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return openai(modelName);
    case 'google':
      if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new Error('LLM_PROVIDER=google requires GOOGLE_GENERATIVE_AI_API_KEY');
      }
      return google(modelName);
    case 'ollama': {
      const ollama = createOllama({ baseURL: `${env.OLLAMA_BASE_URL}/api` });
      return ollama(modelName);
    }
  }
}

/** Singleton model instance. Construction is cheap so a module-level const is fine. */
export const model: LanguageModel = buildModel();
export const fastModel: LanguageModel = buildModel(env.LLM_FAST_MODEL ?? env.LLM_MODEL);

/** True if the active provider supports direct file (PDF/image) inputs. */
export function providerSupportsDirectPdf(): boolean {
  return env.LLM_PROVIDER === 'anthropic' || env.LLM_PROVIDER === 'openai';
}
