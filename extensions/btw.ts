// pi extension: /btw — side-question command (no main-conversation pollution)
//
// Design doc: docs/btw.md (read it before changing request assembly — the
// cache-hit mechanism depends on byte-identical replay of the main thread's
// request prefix: same tools, same system prompt, same message history).
//
// Core idea (Claude Code /btw style):
//   - Fork the REAL context: ctx.getSystemPrompt() + active tools (same
//     order/content as the main agent) + buildSessionContext() messages,
//     replayed verbatim (incl. thinking blocks).
//   - Append a single user message: <system-reminder> constraints + question.
//     This message is the ONLY non-replayed content and sits at the very end
//     so the stable prefix stays cacheable (Anthropic: tools+system+messages).
//   - No tool executor exists: provider.streamSimple() only completes text.
//     A tool_call in the response cannot execute; we surface a notice instead.
//
// Modes: tui → fullscreen overlay (streaming, Esc abort, follow-up composer
// via ui.input); rpc (pi-web) → answer via ui.notify, resume via ui.select,
// "/btw <q>" continues the latest thread; json/print → guarded no-op.
//
// Session purity: nothing is ever appended to the session file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	Context as AiContext,
	Message,
	Model,
	Provider,
	ProviderHeaders,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import { type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-btw.json");

const BTW_WIDGET_KEY = "btw";
const WIDGET_MAX_LINES = 300;

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type BtwThinkingLevel = (typeof THINKING_LEVELS)[number];

const CACHE_RETENTIONS = ["none", "short", "long"] as const;

// Static constraint block (identical every call — part of the cacheable suffix
// shape; the whole side-question message is the new suffix each turn).
const SIDE_QUESTION_REMINDER = `<system-reminder>This is a side question from the user. Answer it directly in a single response.

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns for this question
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

function buildSideQuestionPrompt(question: string): string {
	// Reminder first, then question — mirrors Claude Code's proven /btw layout.
	// The whole message is appended after the replayed prefix either way.
	return `${SIDE_QUESTION_REMINDER}\n\n${question}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface BtwSettings {
	model?: string; // "provider/model-id"; default: current model
	thinkingLevel?: BtwThinkingLevel; // default: current thinking level
	cacheRetention?: "none" | "short" | "long"; // default: provider default (short)
}

function loadSettings(): BtwSettings {
	try {
		if (!existsSync(SETTINGS_PATH)) return {};
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as BtwSettings;
		const settings: BtwSettings = {};
		if (typeof raw.model === "string" && raw.model.includes("/")) settings.model = raw.model;
		if (
			typeof raw.thinkingLevel === "string" &&
			(THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)
		) {
			settings.thinkingLevel = raw.thinkingLevel as BtwThinkingLevel;
		}
		if (
			typeof raw.cacheRetention === "string" &&
			(CACHE_RETENTIONS as readonly string[]).includes(raw.cacheRetention)
		) {
			settings.cacheRetention = raw.cacheRetention as BtwSettings["cacheRetention"];
		}
		return settings;
	} catch {
		return {};
	}
}

function clampThinkingLevel(level: string | undefined): BtwThinkingLevel {
	return level && (THINKING_LEVELS as readonly string[]).includes(level)
		? (level as BtwThinkingLevel)
		: "off";
}

// ---------------------------------------------------------------------------
// Thread state (in-memory; pi rebuilds extension instances on session
// switch/reload, so threads are per-session by design)
// ---------------------------------------------------------------------------

interface BtwTurn {
	question: string;
	answer: string;
	response: AssistantMessage;
}

interface BtwThread {
	id: string;
	title: string;
	// Frozen at thread creation — the replayed prefix for every turn.
	context: { systemPrompt: string; tools: Tool[]; messages: Message[] };
	thinkingLevel: BtwThinkingLevel;
	turns: BtwTurn[];
	createdAt: number;
	updatedAt: number;
}

class BtwThreadRegistry {
	private threads = new Map<string, BtwThread>();
	private nextId = 1;

	create(context: BtwThread["context"], question: string, thinkingLevel: BtwThinkingLevel): BtwThread {
		const thread: BtwThread = {
			id: `btw-${this.nextId++}`,
			title: sanitizeSingleLine(question).slice(0, 60) || "Untitled question",
			context,
			thinkingLevel,
			turns: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.threads.set(thread.id, thread);
		return thread;
	}

	list(): BtwThread[] {
		return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	latest(): BtwThread | undefined {
		return this.list()[0];
	}
}

function sanitizeSingleLine(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Context capture — must mirror the main agent's request byte-for-byte
// ---------------------------------------------------------------------------

function captureContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): BtwThread["context"] {
	// System prompt: exactly what the main agent sends (incl. overrides).
	const systemPrompt = ctx.getSystemPrompt();

	// Tools: active set in the main agent's own order, content from the same
	// tool definitions the registry built agent.state.tools from.
	const activeNames = pi.getActiveTools();
	const defs = new Map(pi.getAllTools().map((t) => [t.name, t]));
	const tools: Tool[] = [];
	for (const name of activeNames) {
		const def = defs.get(name);
		if (def) tools.push({ name: def.name, description: def.description, parameters: def.parameters });
	}

	// Messages: compaction-aware, exactly the LLM-visible branch content.
	const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());

	return { systemPrompt, tools, messages };
}

function buildThreadMessages(thread: BtwThread, nextQuestion: string): Message[] {
	const messages: Message[] = [...thread.context.messages];
	for (const turn of thread.turns) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: buildSideQuestionPrompt(turn.question) }],
			timestamp: Date.now(),
		} as Message);
		messages.push(turn.response);
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: buildSideQuestionPrompt(nextQuestion) }],
		timestamp: Date.now(),
	} as Message);
	return messages;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

interface ResolvedModel {
	model: Model;
	thinkingLevel: BtwThinkingLevel;
	auth: { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> };
}

function hasRequestAuth(auth: { apiKey?: string; headers?: unknown; env?: Record<string, string> }): boolean {
	return Boolean(
		auth.apiKey ||
			(auth.headers && Object.values(auth.headers).some((v) => v !== null && v !== undefined)) ||
			(auth.env && Object.keys(auth.env).length > 0),
	);
}

async function resolveModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: BtwSettings,
): Promise<{ kind: "resolved"; resolved: ResolvedModel } | { kind: "none"; reason: string }> {
	const warnings: string[] = [];
	const currentLevel = clampThinkingLevel(ctx.thinkingLevel ?? "off");
	const thinkingLevel = settings.thinkingLevel ?? currentLevel;

	const candidates: Array<{ model: Model | undefined; label: string }> = [];
	if (settings.model) {
		const slash = settings.model.indexOf("/");
		const provider = settings.model.slice(0, slash);
		const modelId = settings.model.slice(slash + 1);
		const found = ctx.modelRegistry.find(provider, modelId);
		if (!found) {
			warnings.push(`pi-btw model "${settings.model}" not found; using current model`);
		} else {
			candidates.push({ model: found, label: settings.model });
		}
	}
	if (ctx.model) candidates.push({ model: ctx.model, label: "current model" });

	for (const candidate of candidates) {
		if (!candidate.model) continue;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
			if (auth.ok && hasRequestAuth(auth)) {
				for (const w of warnings) ctx.ui.notify(w, "warning");
				return {
					kind: "resolved",
					resolved: {
						model: candidate.model,
						thinkingLevel,
						auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
					},
				};
			}
			if (candidate.label !== "current model") {
				warnings.push(`pi-btw model "${settings.model}" has no credentials; using current model`);
			}
		} catch (error) {
			if (candidate.label !== "current model") {
				warnings.push(
					`pi-btw model "${settings.model}" credentials failed (${error instanceof Error ? error.message : String(error)}); using current model`,
				);
			}
		}
	}
	for (const w of warnings) ctx.ui.notify(w, "warning");
	return { kind: "none", reason: "No model with credentials available for /btw" };
}

// ---------------------------------------------------------------------------
// Side-question execution (no tool executor — completion only)
// ---------------------------------------------------------------------------

interface TurnResult {
	kind: "answered";
	turn: BtwTurn;
}
type TurnOutcome =
	| TurnResult
	| { kind: "aborted" }
	| { kind: "error"; message: string };

function debugDump(thread: BtwThread, resolved: ResolvedModel, messages: Message[]): void {
	const path = process.env.BTW_DEBUG_DUMP;
	if (!path) return;
	try {
		writeFileSync(
			path,
			JSON.stringify(
				{
					model: `${resolved.model.provider}/${resolved.model.id}`,
					thinkingLevel: resolved.thinkingLevel,
					systemPrompt: thread.context.systemPrompt,
					tools: thread.context.tools,
					messages,
				},
				null,
				2,
			),
		);
	} catch {
		// debug aid only
	}
}

async function runTurn(
	provider: Provider,
	thread: BtwThread,
	question: string,
	resolved: ResolvedModel,
	ctx: ExtensionCommandContext,
	options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
): Promise<TurnOutcome> {
	const messages = buildThreadMessages(thread, question);
	debugDump(thread, resolved, messages);

	const streamOptions: SimpleStreamOptions = {
		apiKey: resolved.auth.apiKey,
		headers: resolved.auth.headers,
		env: resolved.auth.env,
		signal: options.signal,
	};
	if (resolved.thinkingLevel !== "off") streamOptions.reasoning = resolved.thinkingLevel;
	const cacheRetention = loadSettings().cacheRetention;
	if (cacheRetention) streamOptions.cacheRetention = cacheRetention;

	// No tool executor exists — streamSimple only completes text. A tool_call in
	// the response is surfaced as a notice by the caller (see below).
	const stream = provider.streamSimple(
		resolved.model,
		{ systemPrompt: thread.context.systemPrompt, messages, tools: thread.context.tools } satisfies AiContext,
		streamOptions,
	);

	try {
		for await (const event of stream) {
			if (event.type === "text_delta") options.onDelta?.(event.delta);
		}
		const response = await stream.result();
		if (response.stopReason === "aborted") return { kind: "aborted" };
		if (response.stopReason === "error") {
			return { kind: "error", message: response.errorMessage ?? "Provider error" };
		}
		const hasToolCall = (response.content ?? []).some((c) => c?.type === "toolCall");
		const answer = (response.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (!answer && hasToolCall) {
			return {
				kind: "error",
				message: "The model tried to call a tool — /btw is read-only and cannot run tools. Try rephrasing.",
			};
		}
		const turn: BtwTurn = { question, answer: answer || "(empty response)", response };
		thread.turns.push(turn);
		thread.updatedAt = Date.now();
		return { kind: "answered", turn };
	} catch (error) {
		if (options.signal?.aborted) return { kind: "aborted" };
		return { kind: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

function describeUsage(response: AssistantMessage): string {
	const u = response.usage;
	if (!u) return "";
	const parts: string[] = [];
	if (u.cacheRead) parts.push(`cache read ${u.cacheRead}`);
	if (u.input) parts.push(`${u.input} in`);
	if (u.output) parts.push(`${u.output} out`);
	const cost = u.cost?.total ? ` · $${u.cost.total.toFixed(4)}` : "";
	return parts.length ? ` · ${parts.join(", ")}${cost}` : "";
}

// ---------------------------------------------------------------------------
// TUI streaming view (minimal component: header + streamed text, Esc aborts)
// ---------------------------------------------------------------------------

function wrapText(text: string, width: number): string[] {
	const effective = Math.max(20, width - 2);
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length <= effective) {
			lines.push(rawLine);
			continue;
		}
		let current = "";
		for (const word of rawLine.split(" ")) {
			if (current && current.length + 1 + word.length > effective) {
				lines.push(current);
				current = word;
			} else {
				current = current ? `${current} ${word}` : word;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

class BtwStreamView implements Component {
	private text = "";
	private phase: "streaming" | "done" | "aborted" | "error" = "streaming";
	private note = "";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly question: string;
	private readonly onAbort: () => void;
	private readonly onClose: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		question: string,
		onAbort: () => void,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.question = question;
		this.onAbort = onAbort;
		this.onClose = onClose;
	}

	append(delta: string): void {
		this.text += delta;
		this.tui.requestRender();
	}

	finish(phase: "done" | "aborted" | "error", note = ""): void {
		this.phase = phase;
		this.note = note;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!matchesKey(data, Key.escape)) return;
		if (this.phase === "streaming") this.onAbort();
		else this.onClose();
	}

	render(width: number): string[] {
		const header =
			this.phase === "streaming"
				? "btw · thinking…  (esc to cancel)"
				: this.phase === "aborted"
					? "btw · cancelled  (esc to close)"
					: this.phase === "error"
						? "btw · error  (esc to close)"
						: "btw · done  (esc to close / continue)";
		const lines = [this.theme.fg("accent", header), this.theme.fg("dim", `Q: ${this.question}`), ""];
		const body =
			this.phase === "error"
				? this.note
				: this.text || (this.phase === "streaming" ? "…" : "(no text)");
		for (const line of wrapText(body, width)) lines.push(line);
		if (this.note && this.phase === "done") lines.push("", this.theme.fg("dim", this.note));
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Command flows
// ---------------------------------------------------------------------------

function showAnswerPanel(
	ctx: ExtensionCommandContext,
	thread: BtwThread,
	turn: BtwTurn,
): void {
	// rpc/pi-web has no overlay; notify() is a 5s toast — unreadable for long
	// answers. setWidget renders a persistent panel above the editor instead;
	// dismissed via /btw clear (or replaced by the next answer).
	const lines: string[] = [];
	lines.push(`btw · ${thread.id} · ${thread.title}`);
	lines.push("");
	const bodyLines = turn.answer.split("\n");
	for (const line of bodyLines.slice(0, WIDGET_MAX_LINES)) lines.push(line);
	if (bodyLines.length > WIDGET_MAX_LINES) {
		lines.push(`… (${bodyLines.length - WIDGET_MAX_LINES} more lines truncated)`);
	}
	lines.push("");
	const usage = describeUsage(turn.response);
	lines.push(`${usage ? `${usage} — ` : ""}dismiss: /btw clear`);
	ctx.ui.setWidget(BTW_WIDGET_KEY, lines);
}

function clearAnswerPanel(ctx: ExtensionCommandContext): void {
	ctx.ui.setWidget(BTW_WIDGET_KEY, undefined);
	ctx.ui.notify("btw · answer panel dismissed", "info");
}

async function resolveProvider(
	ctx: ExtensionCommandContext,
	resolved: ResolvedModel,
): Promise<Provider | undefined> {
	const provider = ctx.modelRegistry.getProvider(resolved.model.provider);
	if (!provider) ctx.ui.notify(`No provider registered for "${resolved.model.provider}"`, "error");
	return provider;
}

async function askFollowUp(ctx: ExtensionCommandContext, thread: BtwThread): Promise<string | undefined> {
	const raw = await ctx.ui.input(
		`/btw ${thread.id} · ${thread.title}`,
		"Follow-up question (empty = exit)",
	);
	const trimmed = raw?.trim();
	return trimmed || undefined;
}

async function runThreadTui(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	thread: BtwThread,
	resolved: ResolvedModel,
	firstQuestion: string,
): Promise<void> {
	const provider = await resolveProvider(ctx, resolved);
	if (!provider) return;

	let pending: string | undefined = firstQuestion;
	while (pending) {
		const question = pending;
		pending = undefined;

		const controller = new AbortController();
		let settled: TurnOutcome | undefined;
		const result = await ctx.ui.custom<TurnOutcome | undefined>(
			(tui, theme, _keybindings, done) => {
				const view = new BtwStreamView(
					tui,
					theme,
					sanitizeSingleLine(question).slice(0, 80),
					() => controller.abort(),
					() => done(settled),
				);
				void runTurn(provider, thread, question, resolved, ctx, {
					signal: controller.signal,
					onDelta: (delta) => view.append(delta),
				}).then((r) => {
					settled = r;
					if (r.kind === "answered") view.finish("done", describeUsage(r.turn.response));
					else if (r.kind === "error") view.finish("error", r.message);
					else view.finish("aborted");
				});
				return view;
			},
		);

		if (!result || result.kind === "aborted") return;
		if (result.kind === "error") {
			ctx.ui.notify(`btw: ${result.message}`, "error");
			return;
		}

		pending = (await askFollowUp(ctx, thread)) ?? undefined;
	}
}

async function runThreadRpc(
	ctx: ExtensionCommandContext,
	thread: BtwThread,
	resolved: ResolvedModel,
	question: string,
): Promise<void> {
	const provider = await resolveProvider(ctx, resolved);
	if (!provider) return;
	ctx.ui.notify(`btw · asking (${thread.id}: ${thread.title})…`, "info");
	const result = await runTurn(provider, thread, question, resolved, ctx);
	if (result.kind === "aborted") return;
	if (result.kind === "error") {
		ctx.ui.notify(`btw: ${result.message}`, "error");
		return;
	}
	showAnswerPanel(ctx, thread, result.turn);
}

export default function btwExtension(pi: ExtensionAPI) {
	const registry = new BtwThreadRegistry();

	pi.registerCommand("btw", {
		description:
			"Ask a side question without touching the main conversation. /btw <question> = new thread; bare /btw = resume menu; /btw clear = dismiss answer panel",
		// Free-form question text — nothing sensible to complete besides the
		// clear subcommand. Resume happens via the bare-/btw menu (in-memory
		// state, not typeable ids).
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trimStart();
			if (normalized && !"clear".startsWith(normalized)) return null;
			return [{ value: "clear", label: "clear — Dismiss the /btw answer panel (pi-web)" }];
		},
		handler: async (args, ctx) => {
			const question = args.trim();
			if (ctx.mode !== "tui" && !ctx.hasUI) {
				return; // json/print modes: nothing sensible to render
			}
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;

			if (question === "clear" || question === "close") {
				clearAnswerPanel(ctx);
				return;
			}

			const settings = loadSettings();
			const resolution = await resolveModel(pi, ctx, settings);
			if (resolution.kind === "none") {
				ctx.ui.notify(`btw: ${resolution.reason}`, "error");
				return;
			}
			const resolved = resolution.resolved;

			// ------------------------------ TUI ------------------------------
			if (ctx.mode === "tui") {
				let thread: BtwThread | undefined;
				let firstQuestion = question;

				if (!firstQuestion) {
					const threads = registry.list();
					if (threads.length > 0) {
						const choice = await ctx.ui.select(
							"btw — resume a thread or start a new one",
							["New question", ...threads.map((t) => `${t.id} · ${t.title} (${t.turns.length} Q&A)`)],
						);
						if (choice === undefined) return;
						if (choice !== "New question") {
							const picked = threads.find((t) => choice.startsWith(`${t.id} ·`));
							if (!picked) return;
							const followUp = await askFollowUp(ctx, picked);
							if (!followUp) return;
							await runThreadTui(pi, ctx, picked, resolved, followUp);
							return;
						}
					}
					const asked = await ctx.ui.input("btw — side question", "What do you want to know?");
					firstQuestion = asked?.trim() ?? "";
					if (!firstQuestion) return;
				}

				thread = registry.create(captureContext(pi, ctx), firstQuestion, resolved.thinkingLevel);
				await runThreadTui(pi, ctx, thread, resolved, firstQuestion);
				return;
			}

			// ------------------------------ RPC (pi-web) ------------------------------
			let thread = registry.latest();
			let effectiveQuestion = question;

			if (!effectiveQuestion) {
				const threads = registry.list();
				if (threads.length === 0) {
					const asked = await ctx.ui.input("btw — side question", "What do you want to know?");
					effectiveQuestion = asked?.trim() ?? "";
					if (!effectiveQuestion) return;
					thread = undefined; // created below
				} else {
					const choice = await ctx.ui.select(
						"btw — resume a thread or start a new one",
						["New question", "Clear answer panel", ...threads.map((t) => `${t.id} · ${t.title}`)],
					);
					if (choice === undefined) return;
					if (choice === "Clear answer panel") {
						clearAnswerPanel(ctx);
						return;
					}
					if (choice === "New question") {
						const asked = await ctx.ui.input("btw — side question", "What do you want to know?");
						effectiveQuestion = asked?.trim() ?? "";
						if (!effectiveQuestion) return;
						thread = undefined;
					} else {
						thread = threads.find((t) => choice.startsWith(`${t.id} ·`));
						const followUp = await ctx.ui.input(
							`/btw ${thread?.id ?? ""} · follow-up`,
							"Follow-up question (empty = exit)",
						);
						effectiveQuestion = followUp?.trim() ?? "";
						if (!effectiveQuestion || !thread) return;
					}
				}
			} else if (thread) {
				// "/btw <q>" in rpc continues the latest thread so follow-ups work
				// without a persistent composer.
				ctx.ui.notify(`btw · continuing ${thread.id}: ${thread.title}`, "info");
			}

			if (!thread) {
				thread = registry.create(captureContext(pi, ctx), effectiveQuestion, resolved.thinkingLevel);
			}
			await runThreadRpc(ctx, thread, resolved, effectiveQuestion);
		},
	});
}

export { btwExtension };
