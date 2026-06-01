/**
 * DeepSeek API Integration
 * ========================
 *
 * Provides OpenAI-compatible streaming chat with the DeepSeek API.
 * Supports DeepSeek V3 (deepseek-chat) and DeepSeek R1 (deepseek-reasoner).
 *
 * API key is read from the DEEPSEEK_API_KEY environment variable.
 */

import { createNormalizedMessage } from './providers/types.js';
import { deepseekAdapter } from './providers/deepseek/adapter.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

const activeDeepseekSessions = new Map();

/**
 * Execute a DeepSeek query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model
 * @param {object} ws - WebSocket writer
 */
export async function queryDeepseek(command, options = {}, ws) {
  const {
    sessionId,
    sessionSummary,
    model = 'deepseek-v4-pro',
  } = options;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      content: 'DEEPSEEK_API_KEY environment variable is not set. Add it to your .env file or container environment.',
      sessionId: sessionId || null,
      provider: 'deepseek',
    }));
    return;
  }

  const currentSessionId = sessionId || `deepseek-${Date.now()}`;
  const abortController = new AbortController();

  activeDeepseekSessions.set(currentSessionId, {
    status: 'running',
    abortController,
    startedAt: new Date().toISOString(),
  });

  try {
    // Send session created event
    sendMessage(ws, createNormalizedMessage({
      kind: 'session_created',
      newSessionId: currentSessionId,
      sessionId: currentSessionId,
      provider: 'deepseek',
    }));

    const body = {
      model,
      messages: [{ role: 'user', content: command }],
      stream: true,
    };

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${errorBody}`);
    }

    // Process SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Reasoning models (e.g. deepseek-v4-pro) stream their chain-of-thought
    // token-by-token via `reasoning_content`. Emitting one message per token
    // floods the UI with hundreds of separate "thinking" bubbles, so accumulate
    // it and emit a SINGLE consolidated thinking message, flushed right before
    // the answer begins (or at stream end for reasoning-only responses).
    let reasoningBuffer = '';
    let reasoningFlushed = false;
    const flushReasoning = () => {
      if (reasoningBuffer && !reasoningFlushed) {
        const thinkingMsgs = deepseekAdapter.normalizeMessage(
          { type: 'thinking', content: reasoningBuffer },
          currentSessionId,
        );
        for (const m of thinkingMsgs) sendMessage(ws, m);
        reasoningFlushed = true;
        reasoningBuffer = '';
      }
    };

    while (true) {
      const session = activeDeepseekSessions.get(currentSessionId);
      if (!session || session.status === 'aborted') break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta;

          if (delta?.reasoning_content) {
            // Buffer reasoning; emitted once via flushReasoning (no per-token spam).
            reasoningBuffer += delta.reasoning_content;
          }

          if (delta?.content) {
            // Answer started: emit the accumulated reasoning as one message first.
            flushReasoning();
            const normalized = deepseekAdapter.normalizeMessage({
              type: 'delta',
              content: delta.content,
            }, currentSessionId);
            for (const msg of normalized) sendMessage(ws, msg);
          }

          if (json.usage) {
            const totalTokens = (json.usage.prompt_tokens || 0) + (json.usage.completion_tokens || 0);
            sendMessage(ws, createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget: { used: totalTokens, total: 128000 },
              sessionId: currentSessionId,
              provider: 'deepseek',
            }));
          }
        } catch (parseErr) {
          // Skip malformed SSE lines
        }
      }
    }

    // Reasoning-only responses (no content delta) still need their thinking shown.
    flushReasoning();

    // Send stream end + completion
    sendMessage(ws, createNormalizedMessage({ kind: 'stream_end', sessionId: currentSessionId, provider: 'deepseek' }));
    sendMessage(ws, createNormalizedMessage({ kind: 'complete', sessionId: currentSessionId, provider: 'deepseek' }));
    // A notification failure (e.g. a missing notifications table) must never
    // surface to the UI or abort the response.
    try {
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'deepseek',
        sessionId: currentSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
    } catch (notifyErr) {
      console.warn('[DeepSeek] notifyRunStopped failed (non-fatal):', notifyErr?.message);
    }

  } catch (error) {
    const session = activeDeepseekSessions.get(currentSessionId);
    const wasAborted = session?.status === 'aborted' || error?.name === 'AbortError';

    if (!wasAborted) {
      console.error('[DeepSeek] Error:', error);
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: error.message,
        sessionId: currentSessionId,
        provider: 'deepseek',
      }));
      try {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'deepseek',
          sessionId: currentSessionId,
          sessionName: sessionSummary,
          error,
        });
      } catch (notifyErr) {
        console.warn('[DeepSeek] notifyRunFailed failed (non-fatal):', notifyErr?.message);
      }
    }
  } finally {
    const session = activeDeepseekSessions.get(currentSessionId);
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

/**
 * Abort an active DeepSeek session
 */
export function abortDeepseekSession(sessionId) {
  const session = activeDeepseekSessions.get(sessionId);
  if (!session) return false;

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (err) {
    console.warn(`[DeepSeek] Failed to abort session ${sessionId}:`, err);
  }
  return true;
}

/**
 * Check if a session is active
 */
export function isDeepseekSessionActive(sessionId) {
  const session = activeDeepseekSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 */
export function getActiveDeepseekSessions() {
  const sessions = [];
  for (const [id, session] of activeDeepseekSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({ id, status: session.status, startedAt: session.startedAt });
    }
  }
  return sessions;
}

function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[DeepSeek] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000;
  for (const [id, session] of activeDeepseekSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeDeepseekSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000);
