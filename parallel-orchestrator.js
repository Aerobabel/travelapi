const ORCHESTRATOR_VERSION = "2026-05-30";
const DEFAULT_CONCURRENCY = Number(process.env.PLANNER_PARALLEL_CONCURRENCY || 4);

function nowIso() {
  return new Date().toISOString();
}

function durationMs(startedAt) {
  return Date.now() - startedAt;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || undefined,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runParallelSteps(steps = [], options = {}) {
  const activeSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const concurrency = Math.max(1, Number(options.concurrency || DEFAULT_CONCURRENCY));
  const logger = options.logger || console;

  const results = await mapLimit(activeSteps, concurrency, async (step, index) => {
    const stepStartedAtMs = Date.now();
    const stepStartedAt = nowIso();
    const name = step.name || `step_${index + 1}`;
    options.onStepStart?.({ name, index, startedAt: stepStartedAt, metadata: step.metadata || {} });

    try {
      const value = await step.run();
      const result = {
        name,
        index,
        status: "fulfilled",
        required: Boolean(step.required),
        metadata: step.metadata || {},
        startedAt: stepStartedAt,
        finishedAt: nowIso(),
        durationMs: durationMs(stepStartedAtMs),
        value,
      };
      options.onStepEnd?.(result);
      return result;
    } catch (error) {
      const result = {
        name,
        index,
        status: "rejected",
        required: Boolean(step.required),
        metadata: step.metadata || {},
        startedAt: stepStartedAt,
        finishedAt: nowIso(),
        durationMs: durationMs(stepStartedAtMs),
        error: serializeError(error),
      };
      logger?.warn?.(`[orchestrator] ${name} failed`, error?.message || error);
      options.onStepEnd?.(result);
      return result;
    }
  });

  const failedRequired = results.some((result) => result.status === "rejected" && result.required);
  const failedOptional = results.some((result) => result.status === "rejected" && !result.required);
  const trace = {
    version: ORCHESTRATOR_VERSION,
    mode: "parallel_all_settled",
    concurrency,
    startedAt,
    finishedAt: nowIso(),
    durationMs: durationMs(startedAtMs),
    total: results.length,
    fulfilled: results.filter((result) => result.status === "fulfilled").length,
    rejected: results.filter((result) => result.status === "rejected").length,
    status: failedRequired ? "failed" : failedOptional ? "degraded" : "passed",
    steps: results.map(({ value, ...result }) => result),
  };

  if (options.throwOnRequiredFailure && failedRequired) {
    const error = new Error("Required parallel planner step failed");
    error.trace = trace;
    throw error;
  }

  return { trace, results };
}

export function appendPipelineTrace(plan = {}, phase = "pipeline", trace = {}) {
  if (!plan || typeof plan !== "object") return plan;
  plan.orchestration = {
    ...(plan.orchestration || {}),
    version: ORCHESTRATOR_VERSION,
    phases: [
      ...((plan.orchestration && Array.isArray(plan.orchestration.phases)) ? plan.orchestration.phases : []),
      {
        phase,
        ...trace,
      },
    ],
  };
  return plan;
}

export default {
  appendPipelineTrace,
  runParallelSteps,
};
