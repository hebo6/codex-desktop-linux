import type { ThreadResumeResponse } from "../protocol/generated";
import type { RpcResponseTiming } from "../protocol/rpc";

const MAX_SAMPLES = 20;

export type ConversationLoadStatus = "pending" | "succeeded" | "failed";

export interface ConversationLoadDiagnostic {
  readonly startedAtMs: number;
  readonly status: ConversationLoadStatus;
  readonly responseWaitMs: number | null;
  readonly jsonParseMs: number | null;
  readonly protocolValidationMs: number | null;
  readonly projectionMs: number | null;
  readonly renderCommitMs: number | null;
  readonly totalMs: number | null;
  readonly responseCharacters: number | null;
  readonly turnCount: number | null;
  readonly itemCount: number | null;
}

interface MutableConversationLoadDiagnostic {
  startedAtMs: number;
  readonly startedAtMonotonicMs: number;
  status: ConversationLoadStatus;
  responseWaitMs: number | null;
  responseReceivedAtMonotonicMs: number | null;
  jsonParseMs: number | null;
  protocolValidationMs: number | null;
  projectionMs: number | null;
  projectionCompletedAtMonotonicMs: number | null;
  renderCommitMs: number | null;
  totalMs: number | null;
  responseCharacters: number | null;
  turnCount: number | null;
  itemCount: number | null;
}

export interface ConversationLoadMeasurement {
  readonly recordFailure: () => void;
  readonly recordResponse: (response: ThreadResumeResponse) => void;
  readonly recordResponseTiming: (timing: RpcResponseTiming) => void;
}

const samples: MutableConversationLoadDiagnostic[] = [];
const samplesByThreadMetadata = new WeakMap<object, MutableConversationLoadDiagnostic>();

export function beginConversationLoadMeasurement(): ConversationLoadMeasurement {
  const startedAtMonotonicMs = performance.now();
  const sample: MutableConversationLoadDiagnostic = {
    startedAtMs: Date.now(),
    startedAtMonotonicMs,
    status: "pending",
    responseWaitMs: null,
    responseReceivedAtMonotonicMs: null,
    jsonParseMs: null,
    protocolValidationMs: null,
    projectionMs: null,
    projectionCompletedAtMonotonicMs: null,
    renderCommitMs: null,
    totalMs: null,
    responseCharacters: null,
    turnCount: null,
    itemCount: null,
  };
  samples.unshift(sample);
  samples.splice(MAX_SAMPLES);

  return {
    recordFailure() {
      const completedAt = performance.now();
      sample.status = "failed";
      sample.totalMs = completedAt - startedAtMonotonicMs;
    },
    recordResponse(response) {
      const completedAt = performance.now();
      const turns = response.initialTurnsPage?.data ?? [];
      sample.status = "succeeded";
      sample.responseWaitMs = completedAt - startedAtMonotonicMs;
      sample.responseReceivedAtMonotonicMs = completedAt;
      sample.totalMs = sample.responseWaitMs;
      sample.turnCount = turns.length;
      sample.itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);
      samplesByThreadMetadata.set(response.thread, sample);
    },
    recordResponseTiming(timing) {
      sample.jsonParseMs = timing.jsonParseMs;
      sample.protocolValidationMs =
        timing.envelopeValidationMs + timing.resultValidationMs;
      sample.responseCharacters = timing.jsonCharacters;
    },
  };
}

export function recordConversationProjection(
  threadMetadata: object,
  projectionMs: number,
): void {
  const sample = samplesByThreadMetadata.get(threadMetadata);
  if (sample === undefined) return;
  sample.projectionMs = projectionMs;
  sample.projectionCompletedAtMonotonicMs = performance.now();
}

export function recordConversationFirstCommit(threadMetadata: object): void {
  const sample = samplesByThreadMetadata.get(threadMetadata);
  if (sample === undefined || sample.renderCommitMs !== null) return;
  const completedAt = performance.now();
  const renderStartedAt = sample.projectionCompletedAtMonotonicMs
    ?? sample.responseReceivedAtMonotonicMs
    ?? sample.startedAtMonotonicMs;
  sample.renderCommitMs = completedAt - renderStartedAt;
  sample.totalMs = completedAt - sample.startedAtMonotonicMs;
}

export function readConversationLoadDiagnostics(): readonly ConversationLoadDiagnostic[] {
  return Object.freeze(samples.map((sample) => Object.freeze({
    startedAtMs: sample.startedAtMs,
    status: sample.status,
    responseWaitMs: sample.responseWaitMs,
    jsonParseMs: sample.jsonParseMs,
    protocolValidationMs: sample.protocolValidationMs,
    projectionMs: sample.projectionMs,
    renderCommitMs: sample.renderCommitMs,
    totalMs: sample.totalMs,
    responseCharacters: sample.responseCharacters,
    turnCount: sample.turnCount,
    itemCount: sample.itemCount,
  })));
}

export function resetConversationLoadDiagnosticsForTests(): void {
  samples.length = 0;
}
