// pi extension: 9router — dynamic OpenAI-compatible provider registration
// Auto-discovers models and combos from 9Router gateway on startup with full
// metadata (contextWindow, maxTokens, reasoning, and multimodal inputs).
//
// Features:
//   - Fetches live models & combos from ${NINEROUTER_URL}/models
//   - Deep capability mapping (exact overrides, glob patterns, name heuristics)
//   - Combo bottleneck resolution (snowy, flash-research, coder, smartmode, etc.)
//   - Offline local cache fallback in ~/.pi/agent/9router-models-cache.json
//   - Command /9router-sync for on-the-fly model refresh without restarting pi

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelCapability {
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
}

export interface PiModelDef {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface RemoteModelItem {
  id: string;
  object?: string;
  owned_by?: string;
}

const DEFAULT_CAPABILITIES: ModelCapability = {
  vision: false,
  reasoning: false,
  contextWindow: 200000,
  maxOutput: 64000,
};

// SEP regex for vision heuristics
const SEP = "[-_/:.]";
const NOT_VISION = new RegExp(
  [
    `(^|${SEP})(image|img)(${SEP}|$)`,
    "stable-image", "gen[0-9]_image", "nanobanana", "imagine",
    "t2v", "i2v", "flux", "dall", "sdxl", "diffusion",
    "embed", "rerank", "guard", "moderation",
    "tts", "stt", "whisper", "voice", "speech", "audio",
  ].join("|"),
  "i",
);
const VISION_NAME = new RegExp(
  [
    `(^|${SEP})(vision|vl|vlm|multimodal|omni|visual)(${SEP}|$)`,
    `[0-9]\\.[0-9]+v(${SEP}|$)`,
    `(^|${SEP})glm-[0-9]+v(${SEP}|$)`,
    "(^|[-_/:.])(llava|pixtral|internvl|cogvlm|minicpm-v|moondream|idefics|fuyu)",
  ].join("|"),
  "i",
);

export function looksLikeVisionModel(modelId?: string): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  if (NOT_VISION.test(id)) return false;
  return VISION_NAME.test(id);
}

export function matchPattern(pattern: string, model: string): boolean {
  const regex = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i",
  );
  return regex.test(model);
}

// Canonical exact-id overrides (matching 9Router's capabilities.js)
export const MODEL_CAPABILITIES: Record<string, Partial<ModelCapability>> = {
  "claude-fable-5-1": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.6": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6-thinking": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.6-thinking": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },

  "glm-5.3": { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  "glm-5.3-flash": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072 },
  "glm-4.6v": { vision: true, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  "glm-4.5v": { vision: true, reasoning: true, contextWindow: 64000, maxOutput: 16384 },

  "deepseek-v4-flash-vision-exp": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 384000 },
  "vision-model": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 },
  "coder-model": { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 65536 },

  "kimi-k3": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "k3": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "kimi-for-coding": { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  "kimi-for-coding-highspeed": { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code": { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code-highspeed": { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },

  "muse-spark-1.2-contributor": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.2-contributor-free": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.3-contributor": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.3-contributor-free": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
};

// Provider-specific overrides (cx, nvidia, ocg, ag)
export const PROVIDER_CAPABILITIES: Record<string, Record<string, Partial<ModelCapability>>> = {
  cx: {
    "gpt-6-astra": { vision: true, reasoning: true, contextWindow: 272000, maxOutput: 128000 },
    "gpt-5.6-sol": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.6-sol-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.6-terra": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.6-terra-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.6-luna": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.6-luna-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.5": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.5-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.4": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.4-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.4-mini": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.4-mini-review": { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.3-codex-spark": { vision: false, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
    "gpt-5.3-codex-spark-review": { vision: false, reasoning: true, contextWindow: 400000, maxOutput: 128000 },
  },
  nvidia: {
    "minimaxai/minimax-m3": { vision: true, reasoning: true, contextWindow: 512000, maxOutput: 131072 },
    "deepseek-ai/deepseek-v4-pro-0813": { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-ai/deepseek-v4-flash-0731": { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 384000 },
    "nemotron-3-ultra-550b-a55b": { vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
    "parakeet-ctc-1.1b-asr": { vision: false, reasoning: false, contextWindow: 200000, maxOutput: 64000 },
  },
  ocg: {
    "mimo-v2.5": { vision: true, reasoning: false, contextWindow: 1048576, maxOutput: 131072 },
    "mimo-v2.5-pro": { vision: true, reasoning: false, contextWindow: 1048576, maxOutput: 131072 },
    "deepseek-v4-flash": { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-flash-vision-exp": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 384000 },
    "qwen3.7-plus": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 },
    "qwen3.6-plus": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 },
    "minimax-m3": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 512000 },
    "glm-5.3-flash": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072 },
    "muse-spark-1.2-contributor": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
    "muse-spark-1.3-contributor": { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  },
  ag: {
    "gemini-pro-agent": { vision: true, reasoning: false, contextWindow: 1048576, maxOutput: 64000 },
    "gpt-oss-120b-medium": { vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
    "claude-sonnet-4-6": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
    "claude-opus-4-6-thinking": { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 },
  },
};

export const PATTERN_CAPABILITIES: Array<{ pattern: string; caps: Partial<ModelCapability> }> = [
  { pattern: "*claude*opus-5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-4*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*fable*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 64000 } },

  { pattern: "*gemini*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemma*", caps: { vision: true, contextWindow: 128000, maxOutput: 32768 } },

  { pattern: "*gpt-6*", caps: { vision: true, reasoning: true, contextWindow: 272000, maxOutput: 128000 } },
  { pattern: "*gpt-5*", caps: { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4.1*", caps: { vision: true, reasoning: false, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4o*", caps: { vision: true, reasoning: false, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4*", caps: { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-3.5*", caps: { vision: false, reasoning: false, contextWindow: 16385, maxOutput: 4096 } },

  { pattern: "*o1*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 100000 } },

  { pattern: "*grok-4.6*", caps: { vision: true, reasoning: true, contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok-4.5*", caps: { vision: true, reasoning: true, contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok*", caps: { vision: true, reasoning: true, contextWindow: 256000, maxOutput: 64000 } },

  { pattern: "*deepseek-v4*", caps: { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*deepseek*", caps: { vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 } },

  { pattern: "*minimax-m3*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax*", caps: { vision: false, reasoning: true, contextWindow: 200000, maxOutput: 131072 } },

  { pattern: "*qwen*coder*", caps: { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*max*", caps: { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*vl*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*omni*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*", caps: { vision: false, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },

  { pattern: "*kimi*k3*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*for-coding*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*", caps: { vision: false, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },

  { pattern: "*glm-5.3*", caps: { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm*", caps: { vision: false, reasoning: true, contextWindow: 200000, maxOutput: 128000 } },

  { pattern: "*muse*spark*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*v2.5*", caps: { vision: true, reasoning: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*", caps: { vision: true, reasoning: false, contextWindow: 262144, maxOutput: 131072 } },

  { pattern: "*llama-4*", caps: { vision: true, reasoning: false, contextWindow: 1000000, maxOutput: 64000 } },
  { pattern: "*llama*", caps: { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 64000 } },
  { pattern: "*codestral*", caps: { vision: false, reasoning: false, contextWindow: 256000, maxOutput: 64000 } },
  { pattern: "*mistral-large*", caps: { vision: true, reasoning: false, contextWindow: 256000, maxOutput: 64000 } },
  { pattern: "*mistral*", caps: { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 64000 } },

  { pattern: "*sonar*", caps: { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 64000 } },
  { pattern: "*perplexity*", caps: { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 64000 } },

  { pattern: "*laguna-s-2.1*free*", caps: { vision: false, reasoning: true, contextWindow: 200000, maxOutput: 32000 } },
  { pattern: "*laguna-s-2.1*", caps: { vision: false, reasoning: true, contextWindow: 1000000, maxOutput: 32000 } },
  { pattern: "*laguna*", caps: { vision: false, reasoning: true, contextWindow: 200000, maxOutput: 32000 } },
];

export function resolveCapabilities(modelStr: string): ModelCapability {
  const slashIdx = modelStr.indexOf("/");
  const provider = slashIdx !== -1 ? modelStr.slice(0, slashIdx) : "";
  const subModel = slashIdx !== -1 ? modelStr.slice(slashIdx + 1) : modelStr;
  const baseModel = modelStr.includes("/") ? modelStr.split("/").pop()! : modelStr;

  let res: ModelCapability = { ...DEFAULT_CAPABILITIES };

  // 1. Provider-specific override
  if (provider && PROVIDER_CAPABILITIES[provider]) {
    const provCaps = PROVIDER_CAPABILITIES[provider];
    if (provCaps[modelStr]) {
      res = { ...res, ...provCaps[modelStr] };
      return finalizeCaps(res, modelStr);
    }
    if (provCaps[subModel]) {
      res = { ...res, ...provCaps[subModel] };
      return finalizeCaps(res, modelStr);
    }
    if (provCaps[baseModel]) {
      res = { ...res, ...provCaps[baseModel] };
      return finalizeCaps(res, modelStr);
    }
  }

  // 2. Canonical exact
  if (MODEL_CAPABILITIES[baseModel]) {
    res = { ...res, ...MODEL_CAPABILITIES[baseModel] };
    return finalizeCaps(res, modelStr);
  }
  if (MODEL_CAPABILITIES[subModel]) {
    res = { ...res, ...MODEL_CAPABILITIES[subModel] };
    return finalizeCaps(res, modelStr);
  }
  if (MODEL_CAPABILITIES[modelStr]) {
    res = { ...res, ...MODEL_CAPABILITIES[modelStr] };
    return finalizeCaps(res, modelStr);
  }

  // 3. Pattern match
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, subModel) || matchPattern(pattern, modelStr)) {
      res = { ...res, ...caps };
      return finalizeCaps(res, modelStr);
    }
  }

  // 4. Fallback floor
  return finalizeCaps(res, modelStr);
}

function finalizeCaps(caps: ModelCapability, modelStr: string): ModelCapability {
  // Name-based vision heuristic check
  if (!caps.vision && looksLikeVisionModel(modelStr)) {
    caps.vision = true;
  }
  return caps;
}

// Predefined 9Router combos with member bottlenecks & modalities
export const KNOWN_COMBOS: Record<string, { name: string; contextWindow: number; maxTokens: number }> = {
  "snowy": {
    name: "snowy (combo: glm-5.3-flash → deepseek-v4-flash → deepseek-ai/deepseek-v4-pro-0813 → gemini-3.7-flash-high → deepseek-ai/deepseek-v4-flash-0731)",
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "flash-research": {
    name: "flash-research (combo: gemini-3.8-flash-high → gpt-5.6-luna → deepseek-v4-flash → deepseek-ai/deepseek-v4-pro-0813 → deepseek-ai/deepseek-v4-flash-0731)",
    contextWindow: 400000,
    maxTokens: 65536,
  },
  "coder": {
    name: "coder (combo: deepseek-v4-flash → gemini-3.7-flash-high → gpt-5.6-luna → deepseek-ai/deepseek-v4-pro-0813 → deepseek-ai/deepseek-v4-flash-0731)",
    contextWindow: 400000,
    maxTokens: 65536,
  },
  "smartmode": {
    name: "smartmode (combo: gpt-5.6-sol → glm-5.3 → claude-opus-4-6-thinking → deepseek-ai/deepseek-v4-pro-0813)",
    contextWindow: 1000000,
    maxTokens: 128000,
  },
};

export function transformToPiModel(item: RemoteModelItem): PiModelDef {
  const isCombo = item.owned_by === "combo" || item.id in KNOWN_COMBOS;

  if (isCombo) {
    const comboInfo = KNOWN_COMBOS[item.id];
    return {
      id: item.id,
      name: comboInfo?.name ?? `${item.id} (combo)`,
      contextWindow: comboInfo?.contextWindow ?? 400000,
      maxTokens: comboInfo?.maxTokens ?? 65536,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  const caps = resolveCapabilities(item.id);
  return {
    id: item.id,
    contextWindow: caps.contextWindow,
    maxTokens: caps.maxOutput,
    reasoning: caps.reasoning,
    input: caps.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function resolveBaseUrl(): string {
  const raw = process.env.NINEROUTER_URL?.trim();
  if (!raw) return "https://9router.tintindev.com/v1";
  let clean = raw.replace(/\/+$/, "");
  // Upgrade http:// to https:// for remote domains.
  // Cloudflare drops the Authorization header when redirecting 301 http -> https,
  // causing 401 Unauthorized unless https is used directly.
  if (
    clean.startsWith("http://") &&
    !clean.includes("localhost") &&
    !clean.includes("127.0.0.1") &&
    !clean.includes("100.") &&
    !clean.includes("192.168.") &&
    !clean.includes("10.")
  ) {
    clean = "https://" + clean.slice(7);
  }
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

function resolveApiKey(): { keyForFetch: string; keyForConfig: string } {
  const envKey = process.env.NINEROUTER_KEY || process.env.ROUTER9_ENDPOINT_KEY;
  const fallbackKey = "sk-2382b76fd1954cb1-7pnyw8-5e4b191a";
  if (process.env.NINEROUTER_KEY) {
    return { keyForFetch: process.env.NINEROUTER_KEY, keyForConfig: "$NINEROUTER_KEY" };
  }
  if (process.env.ROUTER9_ENDPOINT_KEY) {
    return { keyForFetch: process.env.ROUTER9_ENDPOINT_KEY, keyForConfig: "$ROUTER9_ENDPOINT_KEY" };
  }
  return { keyForFetch: fallbackKey, keyForConfig: fallbackKey };
}

const CACHE_FILE = () => path.join(os.homedir(), ".pi", "agent", "9router-models-cache.json");

function readCachedModels(): PiModelDef[] | null {
  try {
    const file = CACHE_FILE();
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as PiModelDef[];
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return null;
}

function writeCachedModels(models: PiModelDef[]): void {
  try {
    const file = CACHE_FILE();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(models, null, 2), "utf8");
  } catch {}
}

const FALLBACK_PRESET_MODELS: PiModelDef[] = [
  { id: "flash-research", name: KNOWN_COMBOS["flash-research"].name, contextWindow: 400000, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  { id: "snowy", name: KNOWN_COMBOS["snowy"].name, contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  { id: "coder", name: KNOWN_COMBOS["coder"].name, contextWindow: 400000, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  { id: "smartmode", name: KNOWN_COMBOS["smartmode"].name, contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  { id: "cx/gpt-6-astra", contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  { id: "cx/gpt-5.6-sol", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  { id: "cx/gpt-5.6-luna", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  { id: "ocg/glm-5.3-flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] },
  { id: "ocg/deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text"] },
  { id: "glm/glm-5.3", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"] },
  { id: "ag/gemini-3.8-flash-high", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  { id: "ag/claude-opus-4-6-thinking", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
];

export async function fetchAndBuildModels(baseUrl: string, apiKey: string): Promise<PiModelDef[]> {
  const urlsToTry = [baseUrl];
  if (baseUrl.startsWith("http://")) {
    urlsToTry.push(baseUrl.replace(/^http:\/\//, "https://"));
  }

  for (const url of urlsToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const payload = (await res.json()) as { data?: RemoteModelItem[] };
        const remoteItems = payload.data ?? [];
        if (remoteItems.length > 0) {
          const built = remoteItems.map(transformToPiModel);
          writeCachedModels(built);
          return built;
        }
      }
    } catch {}
  }

  const cached = readCachedModels();
  if (cached && cached.length > 0) {
    return cached;
  }
  return FALLBACK_PRESET_MODELS;
}

export default async function (pi: ExtensionAPI) {
  if (typeof (pi as any).registerProvider !== "function") {
    return;
  }

  const baseUrl = resolveBaseUrl();
  const { keyForFetch, keyForConfig } = resolveApiKey();

  // Async load models before pi startup finishes
  const models = await fetchAndBuildModels(baseUrl, keyForFetch);

  (pi as any).registerProvider("9router", {
    name: "9Router Gateway",
    baseUrl,
    apiKey: keyForConfig,
    api: "openai-completions",
    models,
  });

  // Allow manual model refresh anytime via /9router-sync
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("9router-sync", {
      description: "Refresh model list and combos dynamically from 9Router",
      async handler(args: string, ctx: any) {
        const notify = ctx?.ui?.notify ?? ((msg: string) => console.log(msg));
        notify("Refreshing models from 9Router…", "info");

        const updatedModels = await fetchAndBuildModels(baseUrl, keyForFetch);
        (pi as any).registerProvider("9router", {
          name: "9Router Gateway",
          baseUrl,
          apiKey: keyForConfig,
          api: "openai-completions",
          models: updatedModels,
        });

        notify(`✅ Synced ${updatedModels.length} models from 9Router`, "info");
      },
    });
  }
}
