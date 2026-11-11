import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEBUG_ENV, createDebug, registrySnapshot } from "../src/debug.ts";

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

/** A scratch file outside the worktree, removed by the caller. */
function scratch(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-debug-"));
	return { dir, file: join(dir, "events.jsonl") };
}

function lines(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("R5: with the variable unset nothing is written at all", () => {
	const written: string[] = [];
	const write = createDebug({ env: {}, append: (_path, line) => written.push(line) });
	write({ event: "agent_start", token: "[working]" });
	write({ event: "tool_call", toolName: "bash", token: "[working]" });
	assert.deepEqual(written, [], "an unset variable means no diagnostics, not a default path");
	assert.equal(DEBUG_ENV, "PI_HERDR_STATUS_DEBUG");
});

test("R5: with the variable set one JSON line per event carries the event, the ids, the registry and the token", async () => {
	const { dir, file } = scratch();
	const registry = {
		phases: new Map([["s1", { phase: "checking", source: "gentle-pi" }]]),
		get: (sessionId: string) => (sessionId === "s1" ? "checking" : undefined),
	};
	try {
		await withRegistry(registry, () => {
			const write = createDebug({ env: { [DEBUG_ENV]: file } });
			write({ event: "agent_start", ctxSessionId: "s1", sessionId: "s1", rawPhase: "checking", token: "[checking]" });
			write({ event: "tool_result", toolName: "gentle_odd_phase", ctxSessionId: "s1", sessionId: "s2", rawPhase: null, token: "[working]" });
		});
		const [first, second] = lines(file);
		assert.deepEqual(first, {
			ts: first.ts,
			pid: first.pid,
			event: "agent_start",
			toolName: null,
			ctxSessionId: "s1",
			sessionId: "s1",
			registryType: "object",
			registrySessions: [{ id: "s1", phase: "checking", source: "gentle-pi" }],
			rawPhase: "checking",
			token: "[checking]",
		});
		assert.equal(typeof first.ts, "string");
		assert.equal(first.pid, process.pid, "the pid tells which Pi instance wrote the line");
		assert.equal(second.event, "tool_result");
		assert.equal(second.toolName, "gentle_odd_phase");
		assert.equal(second.ctxSessionId, "s1");
		assert.equal(second.sessionId, "s2", "the id actually used is logged aside from the event's own");
		assert.equal(second.rawPhase, null);
		assert.equal(second.token, "[working]");
		assert.ok(existsSync(file));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R5: the registry is read defensively, so an absent or odd one never breaks the line", async () => {
	for (const value of [undefined, null, 42, "registry", {}, { phases: null }, { phases: {} }, { get: "nope" }]) {
		const snapshot = await withRegistry(value, () => registrySnapshot());
		assert.deepEqual(snapshot.sessions, [], String(value));
	}
	await withRegistry(undefined, () => assert.equal(registrySnapshot().type, "undefined"));
	await withRegistry(42, () => assert.equal(registrySnapshot().type, "number"));
	await withRegistry({ get: () => "checking" }, () => assert.equal(registrySnapshot().type, "object"));
	await withRegistry({ phases: { get: () => { throw new Error("boom"); }, keys: () => ["s1"] } }, () => {
		assert.deepEqual(registrySnapshot().sessions, [{ id: "s1", phase: null, source: null }]);
	});
	await withRegistry({ phases: { get: () => { throw new Error("boom"); }, keys: () => { throw new Error("boom"); } } }, () => {
		assert.deepEqual(registrySnapshot().sessions, []);
	});
});

test("R5: a failing write never throws and never blocks publishing", () => {
	const { dir } = scratch();
	try {
		const throwing = createDebug({ env: { [DEBUG_ENV]: join(dir, "nope", "events.jsonl") } });
		assert.doesNotThrow(() => throwing({ event: "agent_start", token: "[working]" }));
		const directory = createDebug({ env: { [DEBUG_ENV]: dir } });
		assert.doesNotThrow(() => directory({ event: "agent_start", token: "[working]" }));
		const unset = createDebug({ env: { [DEBUG_ENV]: "  " } });
		assert.doesNotThrow(() => unset({ event: "agent_start", token: "[working]" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
