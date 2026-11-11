import assert from "node:assert/strict";
import { test } from "node:test";

import { createExtension } from "../extensions/pi-herdr-status.ts";
import { TOKEN, type HerdrRequest } from "../src/herdr.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };

function load(env: Record<string, string | undefined> = HERDR_ENV) {
	const handlers = new Map<string, Handler>();
	const bus = new Map<string, (data: unknown) => void>();
	const sent: HerdrRequest[] = [];
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		events: {
			on: (name: string, handler: (data: unknown) => void) => { bus.set(name, handler); return () => bus.delete(name); },
		},
	};
	createExtension({
		env,
		send: async (request) => { sent.push(request); return true; },
		setInterval: () => 0,
		clearInterval: () => {},
	})(pi as never);
	const fire = async (name: string, event: unknown = {}, ctx: unknown = { mode: "tui" }) => {
		await handlers.get(name)?.(event, ctx);
		await new Promise((resolve) => setImmediate(resolve));
	};
	const emit = async (name: string, data: unknown) => {
		bus.get(name)?.(data);
		await new Promise((resolve) => setImmediate(resolve));
	};
	const tokens = () => sent.map((request) => request.params.tokens[TOKEN]);
	return { handlers, bus, sent, fire, emit, tokens };
}

test("outside Herdr nothing is registered", () => {
	const { handlers, bus } = load({});
	assert.equal(handlers.size, 0);
	assert.equal(bus.size, 0);
});

test("a gentle-agents child never registers", () => {
	const { handlers, bus } = load({ ...HERDR_ENV, GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(handlers.size, 0);
	assert.equal(bus.size, 0);
});

test("a non-TUI session (rpc, json, print) never publishes", async () => {
	const { fire, sent } = load();
	await fire("session_start", { reason: "startup" }, { mode: "rpc" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	assert.equal(sent.length, 0);
});

test("session start wipes any stale token, then a subagent shows and clears", async () => {
	const { fire, tokens } = load();
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(tokens(), [null]);
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	assert.deepEqual(tokens(), [null, "explore"]);
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "explore", status: "completed" } },
	});
	assert.deepEqual(tokens(), [null, "explore", null]);
});

test("a background subagent clears when the gentle-pi bus reports it finished", async () => {
	const { fire, emit, tokens } = load();
	await fire("session_start", { reason: "startup" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "worker", task: "x", mode: "background" } });
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "worker", status: "running" } },
	});
	assert.equal(tokens().at(-1), "worker");
	await emit("gentle-pi:notification:source", { source: "main", event: "agent.completed" });
	assert.equal(tokens().at(-1), "worker", "main-agent events are ignored");
	await emit("gentle-pi:notification:source", { source: "subagent", taskId: "t1", status: "completed", event: "subagent.completed" });
	assert.equal(tokens().at(-1), null);
});

test("opening UI or asking the user never publishes anything", async () => {
	const { fire, emit, sent } = load();
	await fire("session_start", { reason: "startup" });
	const before = sent.length;
	await fire("ui_prompt_start", { kind: "custom" });
	await fire("ui_prompt_end", { kind: "custom" });
	await emit("herdr:blocked", { active: true, label: "question" });
	assert.equal(sent.length, before);
	assert.ok(sent.every((request) => request.method === "pane.report_metadata"), "never pane.report_agent");
});

test("shutdown clears the shown token and stops listening to the bus", async () => {
	const { fire, bus, tokens } = load();
	await fire("session_start", { reason: "startup" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(tokens().at(-1), null);
	assert.equal(bus.size, 0);
});
