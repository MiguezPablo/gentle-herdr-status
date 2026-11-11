/**
 * Tracks the subagents this Pi session launched, in launch order, and renders
 * the sidebar label: a `↳ ` prefix that marks the row as a child, then the oldest
 * running agent name without gentle-pi's `gentle-ai-` prefix, plus how many other agents
 * run alongside it in parentheses when two or more run, e.g. `↳ explore` or
 * `↳ worker (+2)`. Nothing running renders no label at all.
 *
 * The prefix is the only thing the style changes: with the emoji style it is one emoji per
 * agent instead of `↳ ` (`🧭 explore (+1)`, `🔨 worker`, `🔎 verify`, `🤖` for any other),
 * because an arrow says "child" but not which child. El estilo es uno solo para todo el
 * sidebar (`Style`): `plain` es el default. Name, cap and counter are shared.
 *
 * Sources (gentle-pi):
 * - tool_call of `subagent_run` / `subagent_continue` in task mode (the default):
 *   the call blocks until the child finishes, so it runs from the call to its result.
 * - tool_result `details.gentleAgents {taskId, agent, status}`: names every task and,
 *   for background launches, marks it running until a finished status arrives.
 * - status changes from the `gentle-pi:notification:source` bus (no agent name).
 */

import type { Style } from "./phase.ts";

export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** Marks the label as a subagent, never part of the sanitized or capped name. */
export const LABEL_PREFIX = "↳ ";

/**
 * Un emoji por agente, de un solo codepoint y sin selector de variación U+FE0F, así que el
 * terminal dibuja un glifo. Se busca por el nombre ya acortado (sin `gentle-ai-`).
 */
export const SUBAGENT_EMOJIS: Readonly<Record<string, string>> = {
	explore: "🧭",
	worker: "🔨",
	verify: "🔎",
};

/** Emoji de cualquier otro agente: no se inventa un rol que no se conoce. */
export const OTHER_SUBAGENT_EMOJI = "🤖";

const RUN_TOOL = "subagent_run";
const CONTINUE_TOOL = "subagent_continue";
const FALLBACK_NAME = "subagent";
/** Prefijo con el que gentle-pi nombra a sus agentes; sobra en el sidebar. */
const AGENT_PREFIX = "gentle-ai-";
const MAX_NAME = 32;

type Entry = { agent: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One printable line: escape sequences, then control characters, trimmed and capped. */
export function sanitizeName(value: string): string {
	const clean = value
		// OSC entera (título de terminal, hyperlinks): termina en BEL o en ST (ESC \\)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(clean).slice(0, MAX_NAME).join("").trim();
}

/**
 * Nombre visible de un agente: sin el prefijo `gentle-ai-` (el tope de caracteres se
 * aplica después de acortarlo) y con el fallback neutro cuando sólo quedaba el prefijo.
 * Devuelve undefined cuando el nombre crudo viene vacío, para que el llamador lo ignore.
 */
function agentName(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const shortened = trimmed.startsWith(AGENT_PREFIX) ? trimmed.slice(AGENT_PREFIX.length) : trimmed;
	return sanitizeName(shortened) || FALLBACK_NAME;
}

export class SubagentTracker {
	/** Insertion order is launch order; keys are `call:<toolCallId>` or `task:<taskId>`. */
	private readonly running = new Map<string, Entry>();
	/** taskId -> agent for every task seen, so resumes and status changes can be named. */
	private readonly names = new Map<string, string>();

	toolCall(toolCallId: string, toolName: string, input: unknown): void {
		if (toolName !== RUN_TOOL && toolName !== CONTINUE_TOOL) return;
		if (!record(input) || input.mode === "background") return;
		const agent = toolName === RUN_TOOL
			? agentName(text(input.agent) ?? "")
			: this.names.get(text(input.task_id) ?? "");
		this.running.set(`call:${toolCallId}`, { agent: agent || FALLBACK_NAME });
	}

	toolResult(toolCallId: string, toolName: string, details: unknown): void {
		if (toolName !== RUN_TOOL && toolName !== CONTINUE_TOOL) return;
		this.running.delete(`call:${toolCallId}`);
		const task = record(details) && record(details.gentleAgents) ? details.gentleAgents : undefined;
		const taskId = text(task?.taskId);
		const agent = agentName(text(task?.agent) ?? "");
		const status = text(task?.status);
		if (!taskId || !agent || !status) return;
		this.names.set(taskId, agent);
		if (FINISHED_STATUSES.has(status)) this.running.delete(`task:${taskId}`);
		else this.running.set(`task:${taskId}`, { agent });
	}

	status(taskId: string, status: string): void {
		if (FINISHED_STATUSES.has(status)) this.running.delete(`task:${taskId}`);
	}

	label(style: Style = "plain"): string | null {
		const first = this.running.values().next();
		if (first.done) return null;
		const others = this.running.size - 1;
		const name = first.value.agent;
		const prefix = style === "emoji" ? `${SUBAGENT_EMOJIS[name] ?? OTHER_SUBAGENT_EMOJI} ` : LABEL_PREFIX;
		return others >= 1 ? `${prefix}${name} (+${others})` : `${prefix}${name}`;
	}

	reset(): void {
		this.running.clear();
		this.names.clear();
	}
}
