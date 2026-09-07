#!/usr/bin/env node
import assert from "node:assert";
import {
  resolveCapabilities,
  transformToPiModel,
  fetchAndBuildModels,
  looksLikeVisionModel,
  KNOWN_COMBOS,
} from "../extensions/9router.ts";

console.log("=== Testing 9router extension logic ===");

// 1. Test Combos
for (const comboId of Object.keys(KNOWN_COMBOS)) {
  const model = transformToPiModel({ id: comboId, owned_by: "combo" });
  assert.strictEqual(model.reasoning, true, `${comboId} should have reasoning=true`);
  assert.deepStrictEqual(model.input, ["text", "image"], `${comboId} should support vision`);
  assert(model.contextWindow >= 400000, `${comboId} contextWindow should be >= 400k`);
  assert(model.maxTokens >= 65536, `${comboId} maxTokens should be >= 64k`);
  console.log(`✓ Combo ${comboId}: ctx=${model.contextWindow} maxTokens=${model.maxTokens}`);
}

// 2. Test exact model capabilities
const testCases = [
  { id: "cx/gpt-6-astra", ctx: 272000, max: 128000, vision: true, reasoning: true },
  { id: "cx/gpt-5.6-sol", ctx: 400000, max: 128000, vision: true, reasoning: true },
  { id: "glm/glm-5.3", ctx: 1000000, max: 128000, vision: false, reasoning: true },
  { id: "glm/glm-5.3-flash", ctx: 1000000, max: 131072, vision: true, reasoning: true },
  { id: "glm/glm-4.6v", ctx: 128000, max: 32768, vision: true, reasoning: true },
  { id: "ocg/deepseek-v4-flash", ctx: 1000000, max: 384000, vision: false, reasoning: true },
  { id: "ocg/deepseek-v4-flash-vision-exp", ctx: 1000000, max: 384000, vision: true, reasoning: true },
  { id: "ag/gemini-3.8-flash-high", ctx: 1048576, max: 65536, vision: true, reasoning: true },
  { id: "ag/claude-opus-4-6-thinking", ctx: 1000000, max: 128000, vision: true, reasoning: true },
  { id: "nvidia/minimaxai/minimax-m3", ctx: 512000, max: 131072, vision: true, reasoning: true },
];

for (const tc of testCases) {
  const model = transformToPiModel({ id: tc.id });
  assert.strictEqual(model.contextWindow, tc.ctx, `${tc.id} contextWindow`);
  assert.strictEqual(model.maxTokens, tc.max, `${tc.id} maxTokens`);
  assert.strictEqual(model.reasoning, tc.reasoning, `${tc.id} reasoning`);
  assert.strictEqual(model.input.includes("image"), tc.vision, `${tc.id} vision`);
  console.log(`✓ Model ${tc.id}: ctx=${model.contextWindow} maxTokens=${model.maxTokens} vision=${tc.vision}`);
}

// 3. Test Live Fetch & Build
console.log("\nTesting live fetch from 9Router...");
const baseUrl = "http://9router.tintindev.com/v1";
const apiKey = "sk-2382b76fd1954cb1-7pnyw8-5e4b191a";
const models = await fetchAndBuildModels(baseUrl, apiKey);
assert(models.length > 50, `Expected >50 models, got ${models.length}`);
console.log(`✓ Successfully fetched and built ${models.length} models from live 9Router`);

// Check that snowy, flash-research, coder exist
for (const expected of ["snowy", "flash-research", "coder", "smartmode"]) {
  const found = models.find((m) => m.id === expected);
  assert(found, `Expected combo ${expected} to be in models`);
  console.log(`✓ Verified combo in live list: ${found.id} (${found.name})`);
}

console.log("\nAll 9router extension unit tests passed! ✨");
