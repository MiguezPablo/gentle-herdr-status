import assert from "node:assert/strict";
import { test } from "node:test";

import { createExtension } from "../extensions/pi-herdr-status.ts";
import { PHASE_TOKEN, REFRESH_MS, TOKEN, TTL_MS, type HerdrRequest } from "../src/herdr.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type PhaseReader = (sessionId: string) => unknown;

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const TUI_CTX = { mode: "tui", sessionManager: { getSessionId: () => "s1" } };

function load(env: Record<string, string | undefined> = HERDR_ENV, deps: { readPhase?: PhaseReader } = {}) {
	const handlers = new Map<string, Handler>();
	const bus = new Map<string, (data: unknown) => void>();
	const sent: HerdrRequest[] = [];
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextTimer = 1;
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		events: {
			on: (name: string, handler: (data: unknown) => void) => { bus.set(name, handler); return () => bus.delete(name); },
		},
	};
	createExtension({
		env,
		send: async (request) => { sent.push(request); return true; },
		readPhase: deps.readPhase,
		setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
		clearInterval: (id) => { timers.delete(id as number); },
	})(pi as never);
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	const fire = async (name: string, event: unknown = {}, ctx: unknown = TUI_CTX) => {
		await handlers.get(name)?.(event, ctx);
		await flush();
	};
	const emit = async (name: string, data: unknown) => {
		bus.get(name)?.(data);
		await flush();
	};
	const tick = async (ms: number) => {
		for (const timer of [...timers.values()]) if (timer.ms === ms) timer.fn();
		await flush();
	};
	const timerCount = (ms: number) => [...timers.values()].filter((timer) => timer.ms === ms).length;
	return {
		handlers,
		bus,
		sent,
		fire,
		emit,
		tokens: () => sent.map((request) => request.params.tokens[TOKEN] ?? null),
		phases: () => sent.map((request) => request.params.tokens[PHASE_TOKEN] ?? null),
		last: () => sent.at(-1)?.params,
		refresh: () => tick(REFRESH_MS),
		refreshTimers: () => timerCount(REFRESH_MS),
		timerMs: () => [...timers.values()].map((timer) => timer.ms),
	};
}

test("outside Herdr nothing is registered", () => {
	const { handlers, bus } = load({});
	assert.equal(handlers.size, 0);
	assert.equal(bus.size, 0);
});

test("R3: a gentle-agents child never publishes anything", async () => {
	const { handlers, bus, fire, sent } = load({ ...HERDR_ENV, GENTLE_PI_AGENTS_CHILD: "1" }, { readPhase: () => "exploring" });
	assert.equal(handlers.size, 0);
	assert.equal(bus.size, 0);
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	assert.equal(sent.length, 0);
});

test("R3: a non-TUI session (rpc, json, print) never publishes a phase", async () => {
	const { fire, sent } = load(HERDR_ENV, { readPhase: () => "exploring" });
	await fire("session_start", { reason: "startup" }, { mode: "rpc", sessionManager: { getSessionId: () => "s1" } });
	await fire("agent_start", { type: "agent_start" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	assert.equal(sent.length, 0);
});

test("session start wipes any stale token, then a subagent shows and clears", async () => {
	const { fire, tokens, phases } = load();
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(tokens(), [null]);
	assert.deepEqual(phases(), [null]);
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	assert.deepEqual(tokens(), [null, "↳ explore"]);
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "explore", status: "completed" } },
	});
	assert.deepEqual(tokens(), [null, "↳ explore", null]);
});

test("R1: while the agent works $phase shows the current ODD phase next to pi", async () => {
	let phase: unknown = "exploring";
	let askedSession: string | undefined;
	const { fire, last, phases, tokens, timerMs } = load(HERDR_ENV, {
		readPhase: (sessionId) => {
			askedSession = sessionId;
			return phase;
		},
	});
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(askedSession, "s1", "the registry is keyed by this session");
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: "[exploring]" }, "row reads pi [exploring]");
	assert.equal(tokens().at(-1), null, "the subagent token stays untouched");
	phase = "implementing";
	await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
	assert.equal(phases().at(-1), "[implementing]", "a tool call re-reads the phase");
	phase = "Checking…";
	await fire("tool_result", { toolCallId: "c1", toolName: "gentle_odd_phase", details: {} });
	assert.equal(phases().at(-1), "[checking]", "a tool result re-reads it, lowercase and without ellipsis");
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: "[checking]" });
	assert.deepEqual(timerMs(), [REFRESH_MS], "the phase has no timer of its own");
});

test("R1: each event reads the session id from its own ctx, so a resumed session still finds the phase", async () => {
	const registry = new Map<string, unknown>([["s2", "checking"]]);
	const { fire, last } = load(HERDR_ENV, { readPhase: (sessionId) => registry.get(sessionId) });
	const ctx = (sessionId: string) => ({ mode: "tui", sessionManager: { getSessionId: () => sessionId } });
	await fire("session_start", { reason: "startup" }, ctx("s1"));
	await fire("agent_start", { type: "agent_start" }, ctx("s2"));
	assert.equal(last()!.tokens[PHASE_TOKEN], "[checking]", "the turn start uses the id of its own event");
	await fire("tool_result", { toolCallId: "c1", toolName: "gentle_odd_phase", details: {} }, ctx("s2"));
	assert.equal(last()!.tokens[PHASE_TOKEN], "[checking]", "and so does a tool result");
	await fire("tool_call", { toolCallId: "c2", toolName: "bash", input: { command: "ls" } }, ctx("s2"));
	assert.equal(last()!.tokens[PHASE_TOKEN], "[checking]", "and so does a tool call");
});

test("R1: an event without a session id keeps the last known one", async () => {
	let asked: string | undefined;
	const { fire, last } = load(HERDR_ENV, {
		readPhase: (sessionId) => {
			asked = sessionId;
			return "implementing";
		},
	});
	await fire("session_start", { reason: "startup" }, { mode: "tui", sessionManager: { getSessionId: () => "s1" } });
	await fire("agent_start", { type: "agent_start" }, undefined);
	assert.equal(asked, "s1", "no ctx falls back to the last known id");
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]");
});

test("R1: the phase is read on turn and tool events only, never polled", async () => {
	let reads = 0;
	const { fire, refresh, timerMs } = load(HERDR_ENV, {
		readPhase: () => {
			reads += 1;
			return "exploring";
		},
	});
	await fire("session_start", { reason: "startup" });
	assert.equal(reads, 0, "nothing is read while idle");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(reads, 1, "the turn start reads the phase");
	await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
	assert.equal(reads, 2, "a tool call reads it again");
	await fire("tool_result", { toolCallId: "c1", toolName: "gentle_odd_phase", details: {} });
	assert.equal(reads, 3, "a tool result reads it again");
	assert.deepEqual(timerMs(), [REFRESH_MS], "the only timer is the publisher's TTL refresh, not a poll");
	await refresh();
	assert.equal(reads, 3, "the TTL refresh republishes the value, it does not re-read the registry");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(reads, 3, "ending the turn only clears the token");
	assert.deepEqual(timerMs(), [], "no timer survives the turn");
});

test("R1: an absent, invalid or throwing phase reads as [working]", async () => {
	const readers: (PhaseReader | undefined)[] = [
		undefined,
		() => undefined,
		() => "dancing",
		() => null,
		() => { throw new Error("boom"); },
	];
	for (const readPhase of readers) {
		const { fire, last } = load(HERDR_ENV, readPhase ? { readPhase } : {});
		await fire("session_start", { reason: "startup" });
		await fire("agent_start", { type: "agent_start" });
		assert.equal(last()!.tokens[PHASE_TOKEN], "[working]", String(readPhase));
	}
});

test("R1: the phase and the subagent token are published together in one report", async () => {
	const { fire, sent } = load(HERDR_ENV, { readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	await fire("agent_start", { type: "agent_start" });
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: "↳ explore", [PHASE_TOKEN]: "[implementing]" });
	const seqs = sent.map((request) => request.params.seq as number);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "one seq stream for both tokens");
	assert.equal(new Set(seqs).size, seqs.length);
});

test("R2: session start publishes an unset phase so a stale token disappears", async () => {
	const { fire, last } = load(HERDR_ENV, { readPhase: () => "exploring" });
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: null });
});

test("R2: the phase disappears when the turn ends and on shutdown, leaving no timer", async () => {
	const { fire, last, timerMs } = load(HERDR_ENV, { readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: null }, "just pi");
	assert.deepEqual(timerMs(), [], "idle stops the refresh and there is no poll to stop");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]");
	await fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: null });
	assert.deepEqual(timerMs(), []);
});

test("R4: the phase token never stays stale: TTL, refresh while shown, clear when idle", async () => {
	const { fire, last, refresh, refreshTimers, timerMs } = load(HERDR_ENV, { readPhase: () => "planning" });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(last()!.ttl_ms, TTL_MS);
	assert.ok(TTL_MS > REFRESH_MS * 2, "two missed refreshes still keep the token");
	assert.equal(refreshTimers(), 1);
	assert.deepEqual(timerMs(), [REFRESH_MS], "only the TTL refresh, never a phase poll");
	await refresh();
	assert.deepEqual(last()!.tokens, { [TOKEN]: null, [PHASE_TOKEN]: "[planning]" });
	assert.equal(last()!.ttl_ms, TTL_MS);
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(last()!.ttl_ms, undefined);
	assert.equal(refreshTimers(), 0);
	assert.deepEqual(timerMs(), []);
});

test("a background subagent clears when the gentle-pi bus reports it finished", async () => {
	const { fire, emit, tokens } = load();
	await fire("session_start", { reason: "startup" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "worker", task: "x", mode: "background" } });
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "worker", status: "running" } },
	});
	assert.equal(tokens().at(-1), "↳ worker");
	await emit("gentle-pi:notification:source", { source: "main", event: "agent.completed" });
	assert.equal(tokens().at(-1), "↳ worker", "main-agent events are ignored");
	await emit("gentle-pi:notification:source", { source: "subagent", taskId: "t1", status: "completed", event: "subagent.completed" });
	assert.equal(tokens().at(-1), null);
});

test("opening UI or asking the user never publishes anything", async () => {
	const { fire, emit, sent, last } = load(HERDR_ENV, { readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	const before = sent.length;
	await fire("ui_prompt_start", { kind: "custom" });
	await fire("ui_prompt_end", { kind: "custom" });
	await emit("herdr:blocked", { active: true, label: "question" });
	assert.equal(sent.length, before);
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]", "a prompt does not change the phase");
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
