import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile(new URL("./travel-eval-prompts.json", import.meta.url), "utf8");
const prompts = JSON.parse(raw);

assert.ok(Array.isArray(prompts), "Prompt suite must be an array");
assert.ok(prompts.length >= 20, "Prompt suite should cover at least 20 travel cases");

const ids = new Set();
for (const item of prompts) {
  assert.equal(typeof item.id, "string", "Each prompt needs an id");
  assert.equal(typeof item.prompt, "string", `${item.id} needs prompt text`);
  assert.ok(item.prompt.length >= 25, `${item.id} prompt is too short`);
  assert.ok(Array.isArray(item.mustHave), `${item.id} needs mustHave criteria`);
  assert.ok(item.mustHave.length >= 3, `${item.id} needs at least 3 criteria`);
  assert.ok(!ids.has(item.id), `Duplicate prompt id: ${item.id}`);
  ids.add(item.id);
}

const coverage = new Set(prompts.flatMap((item) => item.mustHave));
for (const required of [
  "flights",
  "hotels",
  "activities",
  "routeLegs",
  "weather",
  "visa",
  "safety",
  "neighborhoods",
  "costBreakdown",
]) {
  assert.ok(coverage.has(required), `Missing suite coverage for ${required}`);
}

console.log(`Planner contract suite passed (${prompts.length} prompts)`);

