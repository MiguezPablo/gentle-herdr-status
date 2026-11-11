import assert from "node:assert/strict";
import { test } from "node:test";

import { LABEL_PREFIX, OTHER_SUBAGENT_EMOJI, SUBAGENT_EMOJIS, SubagentTracker } from "../src/tracker.ts";

function details(taskId: string, agent: string, status: string) {
	return { gentleAgents: { taskId, agent, status, mode: "background" } };
}

test("no subagent shows nothing", () => {
	const tracker = new SubagentTracker();
	assert.equal(tracker.label(), null);
	tracker.toolCall("c1", "subagent_run", { agent: "explore", task: "x" });
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "completed"));
	assert.equal(tracker.label(), null, "no lone arrow when nothing runs");
});

test("a blocking subagent_run shows its agent from the call until its result", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "explore", task: "map", mode: "task" });
	assert.equal(tracker.label(), "↳ explore");
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "completed"));
	assert.equal(tracker.label(), null);
});

test("subagent_run without mode is blocking (task is the default)", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "worker", task: "x" });
	assert.equal(tracker.label(), "↳ worker");
});

test("a background subagent shows from its launch result until a finished status arrives", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "verify", task: "x", mode: "background" });
	assert.equal(tracker.label(), null, "nothing runs before the launch is confirmed");
	tracker.toolResult("c1", "subagent_run", details("t1", "verify", "running"));
	assert.equal(tracker.label(), "↳ verify");
	tracker.status("t1", "waiting");
	assert.equal(tracker.label(), "↳ verify", "a child waiting on a question still counts");
	tracker.status("t1", "completed");
	assert.equal(tracker.label(), null);
});

test("a background subagent_continue shows its agent from the launch result until a finished status", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "gentle-ai-worker", "completed"));
	assert.equal(tracker.label(), null, "the first run already finished");
	tracker.toolCall("c2", "subagent_continue", { task_id: "t1", prompt: "more", mode: "background" });
	assert.equal(tracker.label(), null, "a background continue counts from its launch result, not the call");
	tracker.toolResult("c2", "subagent_continue", details("t2", "gentle-ai-worker", "running"));
	assert.equal(tracker.label(), "↳ worker", "it shows the agent of the resumed task, without the prefix");
	tracker.status("t2", "waiting");
	assert.equal(tracker.label(), "↳ worker", "a child waiting on a question still counts");
	tracker.status("t2", "completed");
	assert.equal(tracker.label(), null);
});

test("a blocking subagent that returns waiting on a question keeps showing until the bus finishes it", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "worker", task: "x" });
	tracker.toolResult("c1", "subagent_run", details("t1", "worker", "waiting"));
	assert.equal(tracker.label(), "↳ worker");
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

test("two or more running subagents show the oldest name plus how many others run", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	tracker.toolResult("c2", "subagent_run", details("t2", "worker", "running"));
	tracker.toolCall("c3", "subagent_run", { agent: "verify", task: "x" });
	assert.equal(tracker.label(), "↳ explore (+2)");
	tracker.status("t1", "completed");
	assert.equal(tracker.label(), "↳ worker (+1)");
	tracker.toolResult("c3", "subagent_run", details("t3", "verify", "completed"));
	assert.equal(tracker.label(), "↳ worker");
});

test("a blocking subagent_continue takes the agent of the task it resumes", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "completed"));
	tracker.toolCall("c2", "subagent_continue", { task_id: "t1", prompt: "more" });
	assert.equal(tracker.label(), "↳ explore");
	tracker.toolResult("c2", "subagent_continue", details("t2", "explore", "completed"));
	assert.equal(tracker.label(), null);
});

test("a blocking subagent_continue of an unknown task falls back to a neutral word", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_continue", { task_id: "zz", prompt: "more" });
	assert.equal(tracker.label(), "↳ subagent");
});

test("the label drops gentle-pi's gentle-ai- prefix from the agent name", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "gentle-ai-explore", task: "x" });
	assert.equal(tracker.label(), "↳ explore", "blocking subagent_run");
	tracker.toolResult("c1", "subagent_run", details("t1", "gentle-ai-explore", "completed"));
	assert.equal(tracker.label(), null);

	tracker.toolResult("c2", "subagent_run", details("t2", "gentle-ai-worker", "running"));
	assert.equal(tracker.label(), "↳ worker", "background subagent");

	tracker.toolCall("c3", "subagent_continue", { task_id: "t2", prompt: "more" });
	assert.equal(tracker.label(), "↳ worker (+1)", "subagent_continue of a known task keeps the counter");
	tracker.toolResult("c3", "subagent_continue", details("t3", "gentle-ai-worker", "completed"));
	tracker.status("t2", "completed");
	assert.equal(tracker.label(), null);
});

test("an agent name without the gentle-ai- prefix is unchanged", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "reviewer", task: "x" });
	assert.equal(tracker.label(), "↳ reviewer");
	tracker.toolResult("c1", "subagent_run", details("t1", "reviewer", "completed"));
	assert.equal(tracker.label(), null);
});

test("an agent named only gentle-ai- falls back to the neutral word", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "gentle-ai-", task: "x" });
	assert.equal(tracker.label(), "↳ subagent");
});

test("the cap applies to the name after dropping the prefix", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: `gentle-ai-${"x".repeat(40)}`, task: "x" });
	assert.equal(tracker.label(), `↳ ${"x".repeat(32)}`);
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
	assert.ok(label.length <= 42, `capped: ${label.length}`);
	assert.ok(label.startsWith(LABEL_PREFIX + "evil name"), "the prefix is not counted in the cap");
	assert.equal(LABEL_PREFIX, "↳ ");
});

test("terminal escape sequences are removed whole, including OSC titles", () => {
	const tracker = new SubagentTracker();
	tracker.toolCall("c1", "subagent_run", { agent: "evil\u001b]0;título\u0007name", task: "x" });
	assert.equal(tracker.label(), "↳ evilname", "a BEL-terminated OSC leaves no residue");
	tracker.reset();
	tracker.toolCall("c2", "subagent_run", { agent: "evil\u001b]0;título\u001b\\name", task: "x" });
	assert.equal(tracker.label(), "↳ evilname", "an ST-terminated OSC leaves no residue either");
	tracker.reset();
	tracker.toolCall("c3", "subagent_run", { agent: "evil\u001b]8;;https://example.com\u0007name", task: "x" });
	assert.equal(tracker.label(), "↳ evilname", "a hyperlink OSC is removed too");
	tracker.reset();
	tracker.toolCall("c4", "subagent_run", { agent: "evil\u001b[31mname", task: "x" });
	assert.equal(tracker.label(), "↳ evilname", "CSI sequences keep being removed");
});

test("reset forgets everything", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	tracker.toolCall("c2", "subagent_run", { agent: "worker", task: "x" });
	tracker.reset();
	assert.equal(tracker.label(), null);
});

/** Un emoji de un solo codepoint evita que el terminal dibuje dos glifos. */
function assertSingleCodepoint(emoji: string, label: string): void {
	assert.equal(Array.from(emoji).length, 1, `${label}: one codepoint`);
	assert.ok(!emoji.includes("\uFE0F"), `${label}: no variation selector`);
}

test("S14: the subagent emoji map is one codepoint per agent, without U+FE0F", () => {
	assert.deepEqual({ ...SUBAGENT_EMOJIS }, { explore: "🧭", worker: "🔨", verify: "🔎" });
	for (const [agent, emoji] of Object.entries(SUBAGENT_EMOJIS)) assertSingleCodepoint(emoji, agent);
	assertSingleCodepoint(OTHER_SUBAGENT_EMOJI, "fallback");
	assert.equal(OTHER_SUBAGENT_EMOJI, "🤖");
});

test("S14: the emoji style replaces the arrow with the agent's emoji, counter and cap unchanged", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	assert.equal(tracker.label("emoji"), "🧭 explore");
	tracker.toolCall("c2", "subagent_run", { agent: "worker", task: "x" });
	assert.equal(tracker.label("emoji"), "🧭 explore (+1)", "the counter goes in parentheses, as with the arrow");
	tracker.status("t1", "completed");
	assert.equal(tracker.label("emoji"), "🔨 worker");
	tracker.reset();
	tracker.toolCall("c3", "subagent_run", { agent: "gentle-ai-verify", task: "x" });
	assert.equal(tracker.label("emoji"), "🔎 verify", "the map uses the name after dropping the prefix");
	tracker.reset();
	tracker.toolCall("c4", "subagent_run", { agent: "reviewer", task: "x" });
	assert.equal(tracker.label("emoji"), "🤖 reviewer", "any other agent gets the neutral robot");
	tracker.reset();
	tracker.toolCall("c5", "subagent_run", { agent: "explore-x", task: "x" });
	assert.equal(tracker.label("emoji"), "🤖 explore-x", "only the exact agent name has its own emoji");
});

test("S14/PRESERVE: the plain style is the default and keeps every label byte for byte", () => {
	const tracker = new SubagentTracker();
	tracker.toolResult("c1", "subagent_run", details("t1", "explore", "running"));
	tracker.toolCall("c2", "subagent_run", { agent: "worker", task: "x" });
	assert.equal(tracker.label(), "↳ explore (+1)");
	assert.equal(tracker.label("plain"), "↳ explore (+1)", "the explicit plain style equals the default");
	tracker.reset();
	tracker.toolCall("c3", "subagent_run", { agent: `evil\nname\u001b[31m${"x".repeat(80)}`, task: "x" });
	assert.equal(tracker.label("plain"), `↳ evil name${"x".repeat(23)}`, "sanitized and capped as before");
	assert.equal(tracker.label("emoji"), `🤖 evil name${"x".repeat(23)}`, "the emoji keeps the same sanitized name");
});
