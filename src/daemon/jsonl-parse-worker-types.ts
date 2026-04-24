import type { ParseLinesRequest, ParseLinesResult } from './jsonl-parse-core.js';

/**
 * Message envelope for the JSONL parse worker.
 * Mirrors the shape used by timeline-projection-types.ts so the two clients
 * can share a mental model (and, if we ever want to, share transport code).
 */
export interface JsonlParseRequestMap {
  parseLines: ParseLinesRequest;
  forgetSession: { sessionName: string };
}

export interface JsonlParseResponseMap {
  parseLines: ParseLinesResult;
  forgetSession: true;
}

export type JsonlParseRequestType = keyof JsonlParseRequestMap;

export interface JsonlParseEnvelope<T extends JsonlParseRequestType = JsonlParseRequestType> {
  id: number;
  type: T;
  payload: JsonlParseRequestMap[T];
}

export interface JsonlParseSuccess<T extends JsonlParseRequestType = JsonlParseRequestType> {
  id: number;
  ok: true;
  type: T;
  result: JsonlParseResponseMap[T];
}

export interface JsonlParseFailure<T extends JsonlParseRequestType = JsonlParseRequestType> {
  id: number;
  ok: false;
  type: T;
  error: string;
}

export type JsonlParseResponse = JsonlParseSuccess | JsonlParseFailure;
