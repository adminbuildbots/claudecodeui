/**
 * DeepSeek provider adapter.
 *
 * Normalizes DeepSeek streaming events into NormalizedMessage format.
 * @module adapters/deepseek
 */

import { createNormalizedMessage, generateMessageId } from '../types.js';

const PROVIDER = 'deepseek';

/**
 * Normalize a DeepSeek streaming event into NormalizedMessage(s).
 * @param {object} raw - A transformed event from the DeepSeek stream handler
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  const ts = new Date().toISOString();
  const baseId = generateMessageId('deepseek');

  if (raw.type === 'delta') {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'stream_delta',
      content: raw.content || '',
    })];
  }

  if (raw.type === 'thinking') {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'thinking',
      content: raw.content || '',
    })];
  }

  if (raw.type === 'error') {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'error',
      content: raw.content || raw.message || 'Unknown DeepSeek error',
    })];
  }

  return [];
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const deepseekAdapter = {
  normalizeMessage,
  async fetchHistory(sessionId, opts = {}) {
    // DeepSeek sessions are not persisted to disk in this implementation.
    return {
      messages: [],
      total: 0,
      hasMore: false,
      offset: 0,
      limit: null,
    };
  },
};
