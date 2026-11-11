import assert from "node:assert/strict";
import { test } from "node:test";

import { SubagentTracker } from "../src/tracker.ts";

function details(taskId: string, agent: string, status: string) {
	return { gentleAgents: { taskId, agent, status, mode: "background" } };
}

test("no subagent shows nothing", () => {
	assert.equal(new SubagentTracker().label(), null);
});

test("a blocking subagent_run shows its agent from the call until its result", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "explore", task: "map", mode: "task" });
	assert.equal(tracker.label(), "explore");
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "completed"));
	assert.equal(tracker.label(), null);
});

test("subagent_run without mode is blocking (task is the default)", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "worker", task: "x" });
	assert.equal(tracker.label(), "worker");
});

test("a background subagent shows from its launch result until a finished status arrives", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "verify", task: "x", mode: "background" });
	assert.equal(tracker.label(), null, "nothing runs before the launch is confirmed");
	tracker.toolResult("c1", "subagent_run", details("t1", "verify", "running"));
	assert.equal(tracker.label(), "verify");
	tracker.status("t1", "waiting");
	assert.equal(tracker.label(), "verify", "a child waiting on a question still counts");
	tracker.status("t1", "completed");
	assert.equal(tracker.label(), null);
});

test("a blocking subagent that returns waiting on a question keeps showing until the bus finishes it", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "worker", task: "x" });
	tracker.toolResult("c1", "subagent_run", details("t1", "worker", "waiting"));
	assert.equal(tracker.label(), "worker");
	tracker.status("t1", "completed");
	assert.equal(tracker.label(), null);
});

test("every finished status clears the task", () => {
	for (const finished of ["completed", "failed", "cancelled", "timed_out"]) {
		const tracker = new SubagentTracker();
		tracker.toolResult("c1", "subagent_run", details("t1", "explore", "queued"));
		tracker.status("t1", finished);
		assert.equal(tracker.label(), null, finished);
	}
});

test("two or more running subagents show the oldest name and the total count", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	tracker.toolResult("c2", "subagent_run", details("t2", "worker", "running"));
	tracker.toolCall("c3", "subagent_run", { agent: "verify", task: "x" });
	assert.equal(tracker.label(), "explore (3)");
	tracker.status("t1", "completed");
	assert.equal(tracker.label(), "worker (2)");
	tracker.toolResult("c3", "subagent_run", details("t3", "verify", "completed"));
	assert.equal(tracker.label(), "worker");
});

test("a blocking subagent_continue takes the agent of the task it resumes", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "completed"));
	tracker.toolCall("c2", "subagent_continue", { task_id: "t1", prompt: "more" });
	assert.equal(tracker.label(), "explore");
	tracker.toolResult("c2", "subagent_continue", details("t2", "explore", "completed"));
	assert.equal(tracker.label(), null);
});

test("a blocking subagent_continue of an unknown task falls back to a neutral word", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_continue", { task_id: "zz", prompt: "more" });
	assert.equal(tracker.label(), "subagent");
});

test("a failed tool call without details clears its pending entry", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "explore", task: "x" });
	tracker.toolResult("c1", "subagent_run", undefined);
	assert.equal(tracker.label(), null);
});

test("statuses of tasks this session never launched are ignored", () => {
	const tracker = new SubagentTracker();
	tracker.status("foreign", "running");
	assert.equal(tracker.label(), null);
});

test("other tools and malformed input never change the label", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "bash", { command: "ls" });
	tracker.toolCall("c2", "subagent_status", { task_id: "t1" });
	tracker.toolResult("c3", "subagent_run", { gentleAgents: { taskId: 5 } });
	tracker.toolResult("c4", "subagent_run", "nope");
	assert.equal(tracker.label(), null);
});

test("names are sanitized and capped so the token stays one short line", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: `evil\nname\u001b[31m${"x".repeat(80)}`, task: "x" });
	const label = tracker.label()!;
	assert.ok(!/[\u0000-\u001f\u007f]/.test(label), "no control characters");
	assert.ok(label.length <= 40, `capped: ${label.length}`);
	assert.ok(label.startsWith("evil name"));
});

test("reset forgets everything", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	tracker.toolCall("c2", "subagent_run", { agent: "worker", task: "x" });
	tracker.reset();
	assert.equal(tracker.label(), null);
});
