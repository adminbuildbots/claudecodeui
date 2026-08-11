/**
 * Orchestration provider adapter ("Agent SDK").
 *
 * Orchestration runs through the Claude Code agent SDK (see orchestration-runner.js),
 * so its turns are stored as Claude CLI sessions on disk and its live stream events
 * are already normalized by the Claude adapter. This adapter therefore delegates
 * both `normalizeMessage` and `fetchHistory` to the Claude adapter — mirroring how
 * the DeepSeek adapter works.
 *
 * @module providers/orchestration/adapter
 */

import { claudeAdapter } from '../claude/adapter.js';

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const orchestrationAdapter = {
  normalizeMessage(raw, sessionId) {
    return claudeAdapter.normalizeMessage(raw, sessionId);
  },

  async fetchHistory(sessionId, opts = {}) {
    return claudeAdapter.fetchHistory(sessionId, opts);
  },
};
