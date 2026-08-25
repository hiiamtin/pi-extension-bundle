// Shared compat helpers for pi extension tools.
//
// WHY THIS EXISTS: pi >=0.84 changed registerTool's execute invocation from
//   execute(params)
// to
//   execute(toolCallId, params, signal, onUpdate, context)
// Extensions written against the old signature silently receive the
// toolCallId string as their first arg -> all params become undefined ->
// upstream APIs return confusing HTTP errors. See git history of this repo
// ("fix(web-search): adapt to pi >=0.84").
//
// RULES for every tool in this package:
//   1. Wrap execute with extractToolArgs() below.
//   2. Validate REQUIRED params explicitly and fail loudly.
//   3. After any `pi` upgrade: run scripts/smoke-test.mjs BEFORE real use.

export type ToolCbArgs = unknown[];

/**
 * Normalize execute(...) arguments across pi versions.
 * Returns the params object regardless of calling convention.
 */
export function extractToolArgs(cbArgs: ToolCbArgs): Record<string, unknown> {
  // New convention: (toolCallId: string, params, ...)
  if (typeof cbArgs[0] === "string") {
    return ((cbArgs[1] ?? {}) as Record<string, unknown>) || {};
  }
  // Old convention: (params, ...)
  return ((cbArgs[0] ?? {}) as Record<string, unknown>) || {};
}

/**
 * Return a loud error result when a required string param is missing/empty,
 * or null when everything is present.
 */
export function requireString(
  params: Record<string, unknown>,
  name: string,
): { errorText: string } | null {
  const v = params[name];
  if (typeof v === "string" && v.trim().length > 0) return null;
  return {
    errorText: `error: missing or empty required parameter '${name}' (got ${v === undefined ? "undefined" : JSON.stringify(v)})`,
  };
}

/** Standard text result shape used by our tools. */
export function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text" as const, text }], details: {} };
}
