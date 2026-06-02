/**
 * DeepSeek provider adapter.
 *
 * Normalizes DeepSeek streaming events into NormalizedMessage format, and
 * reloads persisted DeepSeek conversations from the DeepSeek session store so
 * sessions survive refresh and appear in history like the other providers.
 * @module adapters/deepseek
 */

import { createNormalizedMessage, generateMessageId } from '../types.js';
import { claudeAdapter } from '../claude/adapter.js';

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
   * Reload a DeepSeek conversation for display (on refresh / reopen).
   *
   * DeepSeek now runs through the Claude Code agent SDK, so its sessions are
   * stored as Claude CLI sessions on disk. Delegate to the Claude adapter to
   * read them back.
   */
  async fetchHistory(sessionId, opts = {}) {
    return claudeAdapter.fetchHistory(sessionId, opts);
  },
};
