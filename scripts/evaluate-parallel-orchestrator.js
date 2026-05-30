import assert from "node:assert/strict";
import { appendPipelineTrace, runParallelSteps } from "../parallel-orchestrator.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let active = 0;
let maxActive = 0;

const run = await runParallelSteps([
  {
    name: "fast_provider",
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return "ok";
    },
  },
  {
    name: "slow_provider",
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return "ok";
    },
  },
  {
    name: "optional_failure",
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active -= 1;
      throw new Error("provider unavailable");
    },
  },
], {
  concurrency: 2,
  logger: { warn: () => {} },
});

assert.equal(maxActive, 2, "expected bounded parallel execution");
assert.equal(run.trace.mode, "parallel_all_settled");
assert.equal(run.trace.total, 3);
assert.equal(run.trace.fulfilled, 2);
assert.equal(run.trace.rejected, 1);
assert.equal(run.trace.status, "degraded");
assert.equal(run.results[2].status, "rejected");
assert.equal(run.results[2].error.message, "provider unavailable");
assert.equal(run.trace.steps.some((step) => Object.hasOwn(step, "value")), false);

const plan = {};
appendPipelineTrace(plan, "provider_enrichment", run.trace);
assert.equal(plan.orchestration.phases.length, 1);
assert.equal(plan.orchestration.phases[0].phase, "provider_enrichment");
assert.equal(plan.orchestration.phases[0].status, "degraded");

console.log("Parallel orchestrator eval passed");
