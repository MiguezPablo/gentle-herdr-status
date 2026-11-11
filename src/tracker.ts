/**
 * Tracks the subagents this Pi session launched, in launch order, and renders
 * the sidebar label: a `↳ ` prefix that marks the row as a child, then the oldest
 * running agent name, plus the total count in parentheses when two or more run,
 * e.g. `↳ explore` or `↳ worker (3)`. Nothing running renders no label at all.
 *
 * Sources (gentle-pi):
 * - tool_call of `subagent_run` / `subagent_continue` in task mode (the default):
 *   the call blocks until the child finishes, so it runs from the call to its result.
 * - tool_result `details.gentleAgents {taskId, agent, status}`: names every task and,
 *   for background launches, marks it running until a finished status arrives.
 * - status changes from the `gentle-pi:notification:source` bus (no agent name).
 */

export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** Marks the label as a subagent, never part of the sanitized or capped name. */
export const LABEL_PREFIX = "↳ ";

const RUN_TOOL = "subagent_run";
const CONTINUE_TOOL = "subagent_continue";
const FALLBACK_NAME = "subagent";
const MAX_NAME = 32;

type Entry = { agent: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One printable line: control characters become spaces, then trimmed and capped. */
export function sanitizeName(value: string): string {
	const clean = value
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(clean).slice(0, MAX_NAME).join("").trim();
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
			? text(input.agent)
			: this.names.get(text(input.task_id) ?? "");
		this.running.set(`call:${toolCallId}`, { agent: sanitizeName(agent ?? "") || FALLBACK_NAME });
	}

	toolResult(toolCallId: string, toolName: string, details: unknown): void {
		if (toolName !== RUN_TOOL && toolName !== CONTINUE_TOOL) return;
		this.running.delete(`call:${toolCallId}`);
		const task = record(details) && record(details.gentleAgents) ? details.gentleAgents : undefined;
		const taskId = text(task?.taskId);
		const agent = sanitizeName(text(task?.agent) ?? "");
		const status = text(task?.status);
		if (!taskId || !agent || !status) return;
		this.names.set(taskId, agent);
		if (FINISHED_STATUSES.has(status)) this.running.delete(`task:${taskId}`);
		else this.running.set(`task:${taskId}`, { agent });
	}

	status(taskId: string, status: string): void {
		if (FINISHED_STATUSES.has(status)) this.running.delete(`task:${taskId}`);
	}

	label(): string | null {
		const first = this.running.values().next();
		if (first.done) return null;
		const count = this.running.size;
		return count >= 2 ? `${LABEL_PREFIX}${first.value.agent} (${count})` : `${LABEL_PREFIX}${first.value.agent}`;
	}

	reset(): void {
		this.running.clear();
		this.names.clear();
	}
}
