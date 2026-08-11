/**
 * Orchestration runner for the "Agent SDK" provider.
 *
 * Orchestration runs on the SAME Claude Code agent harness (tools, MCP, plugins,
 * skills, native on-disk sessions) as the Claude provider. The only difference:
 * the incoming `model` is actually a STRATEGY id (fan-out / pipeline / debate),
 * which we resolve into (a) the orchestrator's real model, (b) a strategy system
 * prompt, and (c) a roster of subagents. The orchestrator then delegates to those
 * subagents via the built-in Task tool.
 *
 * Because it runs through `queryClaudeSDK`, session persistence, resume, abort,
 * and subagent rendering all come for free — orchestration sessions ARE Claude
 * SDK sessions, so abort/status/active-session handling falls through to the
 * existing Claude paths in index.js.
 *
 * @module orchestration-runner
 */

import { queryClaudeSDK } from './claude-sdk.js';
import { getStrategy } from './providers/orchestration/strategies.js';

/**
 * Run an orchestration turn.
 * @param {string} command - the user prompt
 * @param {object} options - chat options; `options.model` carries the STRATEGY id
 * @param {object} ws - writer with a `.send()` method
 */
export async function queryOrchestration(command, options = {}, ws) {
  const strategy = getStrategy(options.model);

  const orchestrationOptions = {
    ...options,
    provider: 'orchestration',
    // Replace the strategy id with the orchestrator's real model.
    model: strategy.orchestratorModel,
    // Register the strategy's subagent roster; claude-sdk.js passes this through
    // to the SDK `agents` option (Task-tool-invokable subagents).
    agents: strategy.agents,
    // Layered onto the lab-context briefing inside mapCliOptionsToSDK().
    appendSystemPrompt: strategy.systemPrompt,
  };

  return queryClaudeSDK(command, orchestrationOptions, ws);
}
