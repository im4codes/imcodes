/**
 * Worker thread that runs the Claude-Code JSONL parser off the main event loop.
 *
 * Protocol: see `jsonl-parse-worker-types.ts`.
 * Parse logic: see `jsonl-parse-core.ts` (pure, shared with the main-thread fallback).
 *
 * The worker holds a single `ParseContext` for the whole daemon lifetime; the
 * pending tool-call correlation map is keyed by sessionName, so concurrent
 * sessions don't step on each other.
 */

import { parentPort } from 'node:worker_threads';
import {
  createParseContext,
  forgetSession as forgetSessionInCtx,
  parseLines as parseLinesInCtx,
} from './jsonl-parse-core.js';
import type {
  JsonlParseEnvelope,
  JsonlParseRequestType,
  JsonlParseResponse,
} from './jsonl-parse-worker-types.js';

type WorkerRequest = {
  [K in JsonlParseRequestType]: JsonlParseEnvelope<K>;
}[JsonlParseRequestType];

const ctx = createParseContext();

function handleRequest(message: WorkerRequest): unknown {
  switch (message.type) {
    case 'parseLines':
      return parseLinesInCtx(ctx, message.payload);
    case 'forgetSession':
      forgetSessionInCtx(ctx, message.payload.sessionName);
      return true as const;
  }
}

if (!parentPort) {
  throw new Error('jsonl-parse-worker requires parentPort');
}

parentPort.on('message', (message: WorkerRequest) => {
  try {
    const result = handleRequest(message);
    const response: JsonlParseResponse = {
      id: message.id,
      type: message.type,
      ok: true,
      result,
    } as JsonlParseResponse;
    parentPort?.postMessage(response);
  } catch (err) {
    const response: JsonlParseResponse = {
      id: message.id,
      type: message.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort?.postMessage(response);
  }
});
