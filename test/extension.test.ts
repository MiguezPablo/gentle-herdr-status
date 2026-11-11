import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createExtension } from "../extensions/pi-herdr-status.ts";
import { DEBUG_ENV } from "../src/debug.ts";
import { JOBS_SIDEBAR_EVENT } from "../src/jobs.ts";
import {
	CHANGES_TOKEN,
	JOBS_TOKEN,
	NAME_TOKEN,
	PANEL_NAME,
	PHASE_TOKEN,
	REFRESH_MS,
	TOKEN,
	TTL_MS,
	type HerdrRequest,
} from "../src/herdr.ts";
import type { GitRun } from "../src/changes.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type PhaseReader = (sessionId: string) => unknown;

/** gentle-pi's registry key; the diagnostic reads it through the same symbol. */
const REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");

async function withRegistry<T>(value: unknown, run: () => T | Promise<T>): Promise<T> {
	const holder = globalThis as unknown as Record<symbol, unknown>;
	const saved = holder[REGISTRY];
	holder[REGISTRY] = value;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete holder[REGISTRY];
		else holder[REGISTRY] = saved;
	}
}

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const TUI_CTX = { mode: "tui", sessionManager: { getSessionId: () => "s1" } };

/** Todo reporte lleva los cinco tokens; `$name` vale `gentle` mientras la sesión vive. */
const tokensOf = (overrides: Record<string, string | null> = {}) => ({
	[NAME_TOKEN]: PANEL_NAME,
	[TOKEN]: null,
	[PHASE_TOKEN]: null,
	[JOBS_TOKEN]: null,
	[CHANGES_TOKEN]: null,
	...overrides,
});

function load(
	env: Record<string, string | undefined> = HERDR_ENV,
	deps: { readPhase?: PhaseReader; runGit?: GitRun } = {},
) {
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
		runGit: deps.runGit,
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
		names: () => sent.map((request) => request.params.tokens[NAME_TOKEN] ?? null),
		jobs: () => sent.map((request) => request.params.tokens[JOBS_TOKEN] ?? null),
		changes: () => sent.map((request) => request.params.tokens[CHANGES_TOKEN] ?? null),
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
	assert.deepEqual(last()!.tokens, tokensOf({ [PHASE_TOKEN]: "[exploring]" }), "row reads gentle [exploring]");
	assert.equal(tokens().at(-1), null, "the subagent token stays untouched");
	phase = "implementing";
	await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
	assert.equal(phases().at(-1), "[implementing]", "a tool call re-reads the phase");
	phase = "Checking…";
	await fire("tool_result", { toolCallId: "c1", toolName: "gentle_odd_phase", details: {} });
	assert.equal(phases().at(-1), "[checking]", "a tool result re-reads it, lowercase and without ellipsis");
	assert.deepEqual(last()!.tokens, tokensOf({ [PHASE_TOKEN]: "[checking]" }));
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
	assert.deepEqual(timerMs(), [REFRESH_MS], "only the publisher's refresh survives, and it reads no phase");
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
	assert.deepEqual(sent.at(-1)!.params.tokens, tokensOf({ [TOKEN]: "↳ explore", [PHASE_TOKEN]: "[implementing]" }));
	const seqs = sent.map((request) => request.params.seq as number);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "one seq stream for every token");
	assert.equal(new Set(seqs).size, seqs.length);
});

test("R2: session start publishes an unset phase so a stale token disappears", async () => {
	const { fire, last } = load(HERDR_ENV, { readPhase: () => "exploring" });
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(last()!.tokens, tokensOf());
});

test("R2: the phase disappears when the turn ends and on shutdown, with no timer of its own", async () => {
	const { fire, last, timerMs } = load(HERDR_ENV, { readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.deepEqual(last()!.tokens, tokensOf(), "just gentle, no phase");
	assert.deepEqual(timerMs(), [REFRESH_MS], "only the publisher's refresh for $name, never a phase poll");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(last()!.tokens[PHASE_TOKEN], "[implementing]");
	await fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(last()!.tokens, tokensOf({ [NAME_TOKEN]: null }), "shutdown leaves nothing behind");
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
	assert.deepEqual(last()!.tokens, tokensOf({ [PHASE_TOKEN]: "[planning]" }));
	assert.equal(last()!.ttl_ms, TTL_MS);
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(last()!.tokens[PHASE_TOKEN], null, "the phase is cleared and cannot stay stale");
	assert.equal(last()!.ttl_ms, TTL_MS, "$name keeps its own TTL so it expires if Pi dies");
	assert.equal(refreshTimers(), 1, "the refresh stays only for the name, not for the phase");
	assert.deepEqual(timerMs(), [REFRESH_MS], "still no phase poll");
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

test("R5: with PI_HERDR_STATUS_DEBUG unset the extension writes no diagnostic file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-debug-"));
	try {
		const { fire, sent } = load();
		await fire("session_start", { reason: "startup" });
		await fire("agent_start", { type: "agent_start" });
		await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
		await fire("tool_result", { toolCallId: "c1", toolName: "bash", details: {} });
		await fire("agent_end", { type: "agent_end", messages: [] });
		assert.ok(sent.length > 0, "the extension still publishes normally");
		assert.deepEqual(readdirSync(dir), [], "nothing is written when the variable is unset");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R5: a set PI_HERDR_STATUS_DEBUG logs one line per publishing event", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-debug-"));
	const file = join(dir, "events.jsonl");
	const registry = {
		phases: new Map([["s1", { phase: "checking", source: "gentle-pi" }]]),
		get: (sessionId: string) => (sessionId === "s1" ? "checking" : undefined),
	};
	try {
		await withRegistry(registry, async () => {
			const { fire, sent } = load({ ...HERDR_ENV, [DEBUG_ENV]: file });
			await fire("session_start", { reason: "startup" });
			await fire("agent_start", { type: "agent_start" });
			await fire("tool_result", { toolCallId: "c1", toolName: "gentle_odd_phase", details: {} });
			await fire("tool_call", { toolCallId: "c2", toolName: "bash", input: { command: "ls" } });
			await fire("agent_end", { type: "agent_end", messages: [] });
			assert.deepEqual(sent.at(-1)!.params.tokens, tokensOf(), "publishing is unchanged");
		});
		const logged = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.deepEqual(logged.map((entry) => entry.event), [
			"session_start", "agent_start", "tool_result", "tool_call", "agent_end",
		], "one line per publishing event");
		const [start, turn, result, call, end] = logged;
		assert.equal(start.ctxSessionId, "s1");
		assert.equal(start.sessionId, "s1");
		assert.equal(start.registryType, "object");
		assert.deepEqual(start.registrySessions, [{ id: "s1", phase: "checking", source: "gentle-pi" }]);
		assert.equal(start.rawPhase, null, "nothing is read while idle");
		assert.equal(start.token, null);
		assert.equal(turn.rawPhase, "checking");
		assert.equal(turn.token, "[checking]");
		assert.equal(result.toolName, "gentle_odd_phase");
		assert.equal(result.ctxSessionId, "s1");
		assert.equal(result.sessionId, "s1");
		assert.equal(result.rawPhase, "checking");
		assert.equal(result.token, "[checking]", "the token that actually went to Herdr");
		assert.equal(call.toolName, "bash");
		assert.equal(call.token, "[checking]");
		assert.equal(end.rawPhase, null);
		assert.equal(end.token, null, "the token is cleared at the end of the turn");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shutdown clears the shown token and stops listening to the bus", async () => {
	const { fire, bus, tokens } = load();
	await fire("session_start", { reason: "startup" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(tokens().at(-1), null);
	assert.equal(bus.size, 0);
});

/** Un job corriendo: gentle-pi lo publica sin `status`. */
const job = (id: string, label: string, startedAt: number) => ({ id, label, startedAt });
const jobsSnapshot = (sessionId: string, jobs: unknown[]) => ({ sessionId, snapshot: { jobs } });

test("S9: $jobs shows the oldest running job in its own row, even while the agent is idle", async () => {
	const { fire, emit, last, jobs, names, timerMs } = load();
	await fire("session_start", { reason: "startup" });
	assert.equal(jobs().at(-1), null, "no job, no token");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834", "a job runs without a turn, so it shows while idle");
	assert.equal(last()!.tokens[NAME_TOKEN], PANEL_NAME, "the panel name stays");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [
		job("j2", "dev server", 30),
		job("j1", "CI for PR 1834", 10),
	]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834 (+1)", "the oldest job plus how many others run");
	assert.equal(last()!.ttl_ms, TTL_MS, "a shown job rides the shared TTL");
	assert.deepEqual(timerMs(), [REFRESH_MS], "no poll of its own, only the publisher's refresh");
});

test("S9: $jobs ignores another session's event, a malformed payload and finished jobs", async () => {
	const { fire, emit, last, jobs } = load();
	await fire("session_start", { reason: "startup" });
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	const published = last();
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s2", [job("j9", "other session", 10)]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834", "another session never replaces this one");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s2", []));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834", "and never clears it either");
	for (const payload of [undefined, "jobs", {}, { sessionId: "s1" }, { sessionId: "s1", snapshot: { jobs: 7 } }]) {
		await emit(JOBS_SIDEBAR_EVENT, payload);
		assert.equal(last(), published, `${JSON.stringify(payload)} publishes nothing`);
	}
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [
		{ id: "j1", label: "CI for PR 1834", startedAt: 10, status: "exited", endedAt: 20, exitCode: 0 },
	]));
	assert.equal(jobs().at(-1), null, "a finished job clears the token");
});

test("S9: $jobs is cleared on session start and on shutdown", async () => {
	const { fire, emit, last, jobs } = load();
	await fire("session_start", { reason: "startup" });
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834");
	await fire("session_start", { reason: "new" });
	assert.equal(jobs().at(-1), null, "a new session starts without jobs");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834");
	await fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(last()!.tokens, {
		[NAME_TOKEN]: null,
		[TOKEN]: null,
		[PHASE_TOKEN]: null,
		[JOBS_TOKEN]: null,
		[CHANGES_TOKEN]: null,
	}, "shutdown clears every token");
});

test("S10: $name shows gentle from session start, stays while idle and clears on shutdown", async () => {
	const { fire, names, last, refresh } = load(HERDR_ENV, { readPhase: () => "exploring" });
	await fire("session_start", { reason: "startup" });
	assert.equal(names().at(-1), PANEL_NAME, "the panel is called gentle, not pi");
	assert.equal(PANEL_NAME, "gentle", "fixed value, no colors");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(names().at(-1), PANEL_NAME);
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(names().at(-1), PANEL_NAME, "the name stays while the agent is idle");
	await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
	await refresh();
	assert.equal(last()!.tokens[NAME_TOKEN], PANEL_NAME, "refreshed inside its TTL so it expires if Pi dies");
	assert.equal(last()!.ttl_ms, TTL_MS);
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(names().at(-1), null, "shutdown leaves no name behind");
});

test("S11: PI_HERDR_STATUS_STYLE=emoji changes only $phase", async () => {
	const { fire, emit, phases, tokens, names, jobs } = load(
		{ ...HERDR_ENV, PI_HERDR_STATUS_STYLE: "emoji" },
		{ readPhase: () => "exploring" },
	);
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(phases().at(-1), "🔍 exploring", "emoji and the word, no brackets");
	assert.equal(names().at(-1), PANEL_NAME, "$name does not change");
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "explore", task: "x" } });
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "explore", status: "running" } },
	});
	assert.equal(tokens().at(-1), "↳ explore", "$subagent keeps its arrow and its form");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.equal(jobs().at(-1), "⏵ CI for PR 1834", "$jobs is untouched");
	assert.equal(phases().at(-1), "🔍 exploring", "the phase keeps its emoji");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(phases().at(-1), null, "the phase is still cleared when idle");
});

test("PRESERVE: without PI_HERDR_STATUS_STYLE, or with any other value, $phase keeps its brackets", async () => {
	for (const style of [undefined, "EMOJI", " emoji", "emoji ", "squares"]) {
		const env = { ...HERDR_ENV } as Record<string, string | undefined>;
		env.PI_HERDR_STATUS_STYLE = style;
		const { fire, phases } = load(env, { readPhase: () => "checking" });
		await fire("session_start", { reason: "startup" });
		await fire("agent_start", { type: "agent_start" });
		assert.equal(phases().at(-1), "[checking]", JSON.stringify(style));
	}
});

test("PRESERVE: $phase stays clean while idle and $subagent is untouched", async () => {
	const { fire, emit, phases, tokens } = load(HERDR_ENV, { readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	assert.equal(phases().at(-1), null, "idle shows no phase");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(phases().at(-1), "[implementing]");
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "gentle-ai-explore", task: "x" } });
	assert.equal(tokens().at(-1), "↳ explore", "the subagent label keeps its arrow and lost prefix");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(phases().at(-1), null, "back to idle, the phase is gone");
	assert.equal(tokens().at(-1), "↳ explore", "the running subagent still shows");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.equal(phases().at(-1), null, "a jobs event does not resurrect the phase");
	assert.equal(tokens().at(-1), "↳ explore", "and does not touch the subagent token");
	await fire("tool_result", {
		toolCallId: "c1", toolName: "subagent_run",
		details: { gentleAgents: { taskId: "t1", agent: "explore", status: "completed" } },
	});
	assert.equal(tokens().at(-1), null, "the subagent clears exactly as before");
});

/** git falso de `$changes`: HEAD fijo, el numstat y los untracked que pida el test. */
function fakeChangesGit(numstat = "", untracked = "") {
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key === "rev-parse --verify --quiet HEAD") return "abc123\n";
		if (key.startsWith("diff --numstat")) return numstat;
		if (key === "ls-files --others --exclude-standard") return untracked;
		throw new Error(`unexpected git call: ${key}`);
	};
	return { run, calls };
}

const CHANGES_ON = { ...HERDR_ENV, PI_HERDR_STATUS_CHANGES: "1" };
/** Cuántas mediciones arrancaron: una por cada lectura de HEAD. */
const measurements = (calls: string[]) => calls.filter((call) => call === "rev-parse --verify --quiet HEAD").length;

test("S12: without PI_HERDR_STATUS_CHANGES nothing runs git and $changes is always null", async () => {
	for (const value of [undefined, "0", "true", " 1", "1 "]) {
		const env = { ...HERDR_ENV } as Record<string, string | undefined>;
		env.PI_HERDR_STATUS_CHANGES = value;
		const git = fakeChangesGit("9\t9\ta.ts\n");
		const { fire, emit, changes } = load(env, { runGit: git.run });
		await fire("session_start", { reason: "startup" });
		await fire("agent_start", { type: "agent_start" });
		await fire("tool_result", { toolCallId: "c1", toolName: "bash", details: {} });
		await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", []));
		await fire("agent_end", { type: "agent_end", messages: [] });
		assert.deepEqual(git.calls, [], `${JSON.stringify(value)} never runs git`);
		assert.deepEqual(changes(), changes().map(() => null), "the token is published as null");
		assert.ok(changes().length > 0, "the token still travels in every report");
	}
});

test("S12: PI_HERDR_STATUS_CHANGES=1 publishes +added -deleted in the same report as the other tokens", async () => {
	const git = fakeChangesGit("100\t40\ta.ts\n20\t0\tb.ts\n");
	const { fire, last, changes, names, timerMs } = load(CHANGES_ON, { runGit: git.run });
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(git.calls, [
		"rev-parse --verify --quiet HEAD",
		"diff --numstat abc123",
		"ls-files --others --exclude-standard",
	], "one measurement: HEAD, numstat against it, untracked list");
	assert.equal(changes().at(-1), "+120 -40");
	assert.deepEqual(last()!.tokens, tokensOf({ [CHANGES_TOKEN]: "+120 -40" }), "one report carries every token");
	assert.equal(last()!.ttl_ms, TTL_MS, "it rides the shared TTL");
	assert.equal(names().at(-1), PANEL_NAME, "$name is untouched");
	assert.deepEqual(timerMs(), [REFRESH_MS], "no timer of its own, only the publisher's refresh");
});

test("S12: each trigger re-measures, and a tool call does not", async () => {
	const git = fakeChangesGit("7\t2\ta.ts\n");
	const { fire, emit } = load(CHANGES_ON, { runGit: git.run });
	await fire("session_start", { reason: "startup" });
	assert.equal(measurements(git.calls), 1, "session_start measures");
	await fire("agent_start", { type: "agent_start" });
	assert.equal(measurements(git.calls), 2, "agent_start measures");
	await fire("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
	assert.equal(measurements(git.calls), 2, "a tool call is not a trigger");
	await fire("tool_result", { toolCallId: "c1", toolName: "bash", details: {} });
	assert.equal(measurements(git.calls), 3, "every tool result measures");
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", []));
	assert.equal(measurements(git.calls), 4, "a jobs event measures");
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(measurements(git.calls), 5, "agent_end measures");
});

test("S12: events during a measurement collapse into exactly one more", async () => {
	let release: (() => void) | undefined;
	let waitOnce = true;
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key === "rev-parse --verify --quiet HEAD") return "abc123\n";
		if (key.startsWith("diff --numstat")) {
			if (waitOnce) {
				waitOnce = false;
				await new Promise<void>((resolve) => { release = resolve; });
			}
			return "7\t2\ta.ts\n";
		}
		if (key === "ls-files --others --exclude-standard") return "";
		throw new Error(`unexpected git call: ${key}`);
	};
	const { fire, emit, changes } = load(CHANGES_ON, { runGit: run });
	await fire("session_start", { reason: "startup" });
	assert.equal(measurements(calls), 1);
	assert.equal(changes().at(-1), null, "nothing is published until the measurement finishes");
	await fire("agent_start", { type: "agent_start" });
	await fire("tool_result", { toolCallId: "c1", toolName: "bash", details: {} });
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", []));
	assert.equal(measurements(calls), 1, "no second measurement while one is in flight");
	release?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(measurements(calls), 2, "the queued events run one measurement, not three");
	assert.equal(changes().at(-1), "+7 -2");
});

test("S12: a git error clears the token even after a shown value", async () => {
	let fail = false;
	const git = fakeChangesGit("7\t2\ta.ts\n");
	const run: GitRun = async (args, cwd) => {
		if (fail && args[0] === "diff") throw new Error("fatal: not a git repository");
		return git.run(args, cwd);
	};
	const { fire, changes } = load(CHANGES_ON, { runGit: run });
	await fire("session_start", { reason: "startup" });
	assert.equal(changes().at(-1), "+7 -2");
	fail = true;
	await fire("agent_start", { type: "agent_start" });
	assert.equal(changes().at(-1), null, "an error never leaves the previous value");
});

test("S12: $changes stays published while idle, like $jobs", async () => {
	const git = fakeChangesGit("3\t1\ta.ts\n");
	const { fire, last, changes, phases } = load(CHANGES_ON, { runGit: git.run });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	await fire("agent_end", { type: "agent_end", messages: [] });
	assert.equal(changes().at(-1), "+3 -1", "the count survives the end of the turn");
	assert.equal(last()!.tokens[CHANGES_TOKEN], "+3 -1");
	assert.equal(phases().at(-1), null, "the phase still clears when idle");
});

test("S12: shutdown stops measuring and clears $changes", async () => {
	const git = fakeChangesGit("3\t1\ta.ts\n");
	const { fire, last, changes } = load(CHANGES_ON, { runGit: git.run });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	assert.equal(changes().at(-1), "+3 -1");
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(changes().at(-1), null, "shutdown leaves no count behind");
	assert.deepEqual(last()!.tokens, tokensOf({ [NAME_TOKEN]: null }));
	const before = git.calls.length;
	await fire("agent_start", { type: "agent_start" });
	assert.equal(git.calls.length, before, "nothing measures after shutdown");
});

test("PRESERVE: with $changes on, $phase, $subagent, $jobs and $name keep their values", async () => {
	const git = fakeChangesGit("5\t0\ta.ts\n");
	const { fire, emit, last } = load(CHANGES_ON, { runGit: git.run, readPhase: () => "implementing" });
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	await fire("tool_call", { toolCallId: "c1", toolName: "subagent_run", input: { agent: "gentle-ai-explore", task: "x" } });
	await emit(JOBS_SIDEBAR_EVENT, jobsSnapshot("s1", [job("j1", "CI for PR 1834", 10)]));
	assert.deepEqual(last()!.tokens, tokensOf({
		[CHANGES_TOKEN]: "+5 -0",
		[TOKEN]: "↳ explore",
		[PHASE_TOKEN]: "[implementing]",
		[JOBS_TOKEN]: "⏵ CI for PR 1834",
	}), "the other four tokens read exactly as before");
});
