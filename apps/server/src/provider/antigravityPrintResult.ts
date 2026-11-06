function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESULT_STATUSES = new Set([
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
]);
const STREAM_EVENTS = new Set(["init", "step_update", "result", "error"]);

export function isAntigravityPostResponseTimeout(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return (
    trimmed === "timeout waiting for response" || trimmed === "Error: timeout waiting for response"
  );
}

export interface AntigravityTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingTokens: number;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function parseAntigravityTokenUsage(value: unknown): AntigravityTokenUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = asNonNegativeInt(usage.input_tokens);
  const outputTokens = asNonNegativeInt(usage.output_tokens);
  const cacheReadTokens = asNonNegativeInt(usage.cache_read_tokens);
  const thinkingTokens = asNonNegativeInt(usage.thinking_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    thinkingTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    thinkingTokens: thinkingTokens ?? 0,
  };
}

type Step = {
  state?: unknown;
  type?: unknown;
  text: string;
  usage?: AntigravityTokenUsage;
};

/** Consume complete records as they arrive; an interrupted final line must not erase prior output. */
export function createAntigravityPrintResultParser(options?: {
  readonly onStepUsage?: (stepIndex: number, usage: AntigravityTokenUsage) => void;
}) {
  let pending = "";
  let structured = false;
  let streamed = false;
  let streamError: string | undefined;
  let malformedRecord = false;
  let result: Record<string, unknown> | undefined;
  let hasConflictingResultError = false;
  const steps = new Map<number, Step>();

  const acceptResult = (value: Record<string, unknown>) => {
    result = value;
    if (
      (value.status !== "SUCCESS" && value.status !== "ERROR") ||
      (Object.hasOwn(value, "error") &&
        !isAntigravityPostResponseTimeout(
          typeof value.error === "string" ? value.error : undefined,
        ))
    ) {
      hasConflictingResultError = true;
    }
  };

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(trimmed));
    } catch {
      // A truncated protocol header is not a legacy answer. Ordinary markdown
      // and JSON answers still use the plain-text fallback.
      if (/^\{\s*"(?:event|status)"\s*:/.test(trimmed)) structured = true;
      if (structured) malformedRecord = true;
      return;
    }
    if (!value) return;
    if (typeof value.event !== "string" || !STREAM_EVENTS.has(value.event)) {
      if (typeof value.status === "string" && RESULT_STATUSES.has(value.status)) {
        structured = true;
        acceptResult(value);
      }
      return;
    }
    structured = true;
    streamed = true;
    if (value.event === "result") {
      const envelope = record(value.result);
      if (envelope && typeof envelope.status === "string") acceptResult(envelope);
      else malformedRecord = true;
    } else if (value.event === "error") {
      // A subsequent timeout must not erase an earlier real stream failure.
      if (streamError === undefined || isAntigravityPostResponseTimeout(streamError)) {
        streamError =
          typeof value.message === "string" && value.message.trim()
            ? value.message
            : "Antigravity stream failed.";
      }
    } else if (value.event === "step_update") {
      const update = record(value.step_update);
      const index = update?.step_index;
      if (!update || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        malformedRecord = true;
        return;
      }
      const previous = steps.get(index);
      const stepUsage = parseAntigravityTokenUsage(update.usage);
      const effectiveUsage = stepUsage ?? previous?.usage;
      steps.set(index, {
        state: update.state ?? previous?.state,
        type: update.step_type ?? previous?.type,
        text: `${previous?.text ?? ""}${typeof update.text_delta === "string" ? update.text_delta : ""}`,
        ...(effectiveUsage ? { usage: effectiveUsage } : {}),
      });
      if (stepUsage) {
        options?.onStepUsage?.(index, stepUsage);
      }
    }
  };

  return {
    write(chunk: string) {
      pending += chunk;
      let start = 0;
      let end = pending.indexOf("\n", start);
      while (end !== -1) {
        consume(pending.slice(start, end));
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    },
    finish() {
      consume(pending);
      pending = "";
      if (!structured) return undefined;
      const state =
        result?.status === "CANCELED" || result?.status === "INTERRUPTED"
          ? "interrupted"
          : streamError || (result && result.status !== "SUCCESS")
            ? "failed"
            : result?.status === "SUCCESS"
              ? "completed"
              : undefined;
      let lastResponseIndex = -1;
      let lastResponse: Step | undefined;
      for (const [index, step] of steps) {
        if (step.type === "agent_response" && index > lastResponseIndex) {
          lastResponseIndex = index;
          lastResponse = step;
        }
      }
      const hasCompleteAssistantResponse =
        streamed &&
        !malformedRecord &&
        lastResponse?.state === "DONE" &&
        lastResponse.text.trim().length > 0 &&
        [...steps.entries()].every(
          ([index, step]) =>
            step.state === "DONE" && (step.type !== "error" || index < lastResponseIndex),
        );
      const completedResponse =
        hasCompleteAssistantResponse && (state === undefined || state === "completed");
      const hasExplicitResultError = result !== undefined && Object.hasOwn(result, "error");
      const terminalError = typeof result?.error === "string" ? result.error : streamError;
      const resultUsage = parseAntigravityTokenUsage(result?.usage);
      const durationSeconds =
        typeof result?.duration_seconds === "number" &&
        Number.isFinite(result.duration_seconds) &&
        result.duration_seconds >= 0
          ? result.duration_seconds
          : undefined;
      return {
        state,
        hasCompleteAssistantResponse,
        hasExplicitResultError,
        hasConflictingResultError,
        resultStatus: result?.status,
        streamError,
        completedResponse,
        response:
          typeof result?.response === "string" && result.response.trim()
            ? result.response
            : (lastResponse?.text ?? ""),
        error:
          terminalError ??
          (state === "failed" ? `Antigravity ended with status ${result?.status}.` : undefined),
        ...(terminalError !== undefined ? { terminalError } : {}),
        ...(resultUsage !== undefined ? { usage: resultUsage } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        failed: state === "failed",
      };
    },
  };
}

export function parseAntigravityPrintResult(stdout: string) {
  const parser = createAntigravityPrintResultParser();
  parser.write(stdout);
  return parser.finish();
}
