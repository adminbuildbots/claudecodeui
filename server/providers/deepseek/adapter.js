/**
 * DeepSeek provider adapter.
 *
 * Normalizes DeepSeek streaming events into NormalizedMessage format, and
 * reloads persisted DeepSeek conversations from the DeepSeek session store so
 * sessions survive refresh and appear in history like the other providers.
 * @module adapters/deepseek
 */

import { createNormalizedMessage, generateMessageId } from '../types.js';
import deepseekSessionStore, { ready as storeReady } from '../../deepseek-sessions.js';

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

  /**
   * Reload a persisted DeepSeek conversation for display (on refresh / reopen).
   * Returns saved user/assistant turns as normalized 'text' messages.
   */
  async fetchHistory(sessionId, opts = {}) {
    try { await storeReady; } catch { /* store still usable from memory */ }

    const raw = deepseekSessionStore.getSessionMessages(sessionId);
    const messages = [];
    for (const r of raw) {
      const role = r.message?.role || r.role;
      const content = r.message?.content ?? r.content;
      const ts = r.timestamp || new Date().toISOString();
      if (!role || typeof content !== 'string' || !content.trim()) continue;
      messages.push(createNormalizedMessage({
        id: generateMessageId('deepseek'),
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: role === 'user' ? 'user' : 'assistant',
        content,
      }));
    }

    return {
      messages,
      total: messages.length,
      hasMore: false,
      offset: 0,
      limit: null,
    };
  },
};
