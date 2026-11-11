import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	MetadataPublisher,
	PHASE_TOKEN,
	REFRESH_MS,
	SOURCE,
	TOKEN,
	TTL_MS,
	herdrPane,
	socketSend,
	type HerdrRequest,
} from "../src/herdr.ts";

function fakeTimers() {
	const timers = new Map<number, () => void>();
	let next = 1;
	return {
		setInterval: (fn: () => void, _ms: number) => { timers.set(next, fn); return next++; },
		clearInterval: (id: unknown) => { timers.delete(id as number); },
		tick: () => { for (const fn of [...timers.values()]) fn(); },
		count: () => timers.size,
	};
}

function setup(tokens: readonly string[] = [TOKEN]) {
	const sent: HerdrRequest[] = [];
	const timers = fakeTimers();
	const publisher = new MetadataPublisher({
		pane: "w1:p1",
		tokens,
		send: async (request) => { sent.push(request); return true; },
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval,
		now: () => 1000,
	});
	return { sent, timers, publisher };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("herdrPane requires HERDR_ENV=1, a pane and a socket", () => {
	assert.deepEqual(herdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }), { pane: "p", socket: "/s" });
	assert.equal(herdrPane({ HERDR_ENV: "0", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }), undefined);
	assert.equal(herdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: " ", HERDR_SOCKET_PATH: "/s" }), undefined);
	assert.equal(herdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }), undefined);
});

test("the phase and subagent tokens are distinct and neither is a pane state", async () => {
	const { sent, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(PHASE_TOKEN, "exploring");
	await flush();
	const [request] = sent;
	assert.equal(request.method, "pane.report_metadata");
	assert.equal(request.params.pane_id, "w1:p1");
	assert.equal(request.params.source, SOURCE);
	assert.ok(!SOURCE.startsWith("herdr:"), "herdr: sources are reserved");
	assert.equal(request.params.agent, "pi");
	assert.equal(TOKEN, "subagent");
	assert.equal(PHASE_TOKEN, "phase");
	assert.deepEqual(request.params.tokens, { [TOKEN]: null, [PHASE_TOKEN]: "exploring" });
	assert.equal(Object.keys(request.params).some((key) => key === "state"), false);
});

test("a label is published as the subagent token with a TTL, never as pane state", async () => {
	const { sent, publisher } = setup();
	publisher.set(TOKEN, "↳ explore (2)");
	await flush();
	assert.equal(sent.length, 1);
	const [request] = sent;
	assert.equal(request.method, "pane.report_metadata");
	assert.equal(request.params.source, SOURCE);
	assert.equal(request.params.agent, "pi");
	assert.deepEqual(request.params.tokens, { [TOKEN]: "↳ explore (2)" });
	assert.equal(request.params.ttl_ms, TTL_MS);
	assert.ok(TTL_MS > REFRESH_MS * 2, "two missed refreshes still keep the token");
});

test("clearing sends a null token without TTL and stops the refresh", async () => {
	const { sent, timers, publisher } = setup();
	publisher.set(TOKEN, "↳ explore");
	await flush();
	assert.equal(timers.count(), 1);
	publisher.set(TOKEN, null);
	await flush();
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: null });
	assert.equal(sent.at(-1)!.params.ttl_ms, undefined);
	assert.equal(timers.count(), 0);
});

test("the first value is always sent, even a clear, to wipe a stale token", async () => {
	const { sent, publisher } = setup();
	publisher.set(TOKEN, null);
	await flush();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].params.tokens, { [TOKEN]: null });
});

test("declared tokens are wiped together on the first report", async () => {
	const { sent, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(TOKEN, null);
	await flush();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].params.tokens, { [TOKEN]: null, [PHASE_TOKEN]: null });
});

test("both tokens travel in one source with one strictly increasing seq stream", async () => {
	const { sent, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(TOKEN, "↳ explore");
	await flush();
	publisher.set(PHASE_TOKEN, "exploring");
	await flush();
	assert.deepEqual(sent.map((request) => request.params.tokens), [
		{ [TOKEN]: "↳ explore", [PHASE_TOKEN]: null },
		{ [TOKEN]: "↳ explore", [PHASE_TOKEN]: "exploring" },
	]);
	assert.ok(sent.every((request) => request.params.source === SOURCE), "one seq stream per source");
	const seqs = sent.map((request) => request.params.seq as number);
	assert.ok(seqs[0] < seqs[1], String(seqs));
});

test("an unchanged value is not resent, but the refresh republishes it", async () => {
	const { sent, timers, publisher } = setup();
	publisher.set(TOKEN, "worker");
	publisher.set(TOKEN, "worker");
	await flush();
	assert.equal(sent.length, 1);
	timers.tick();
	await flush();
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[1].params.tokens, { [TOKEN]: "worker" });
});

test("the refresh republishes every declared token while one of them is shown", async () => {
	const { sent, timers, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(PHASE_TOKEN, "implementing");
	await flush();
	assert.equal(timers.count(), 1);
	timers.tick();
	await flush();
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: null, [PHASE_TOKEN]: "implementing" });
	assert.equal(sent.at(-1)!.params.ttl_ms, TTL_MS, "the refresh keeps the token alive");
	publisher.set(PHASE_TOKEN, null);
	await flush();
	assert.equal(timers.count(), 0);
});

test("sequence numbers strictly increase", async () => {
	const { sent, publisher } = setup();
	publisher.set(TOKEN, "a");
	await flush();
	publisher.set(TOKEN, "b");
	await flush();
	publisher.set(TOKEN, null);
	await flush();
	const seqs = sent.map((request) => request.params.seq as number);
	assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], String(seqs));
});

test("values set while a send is in flight collapse into the latest one", async () => {
	const sent: HerdrRequest[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const timers = fakeTimers();
	const publisher = new MetadataPublisher({
		pane: "p",
		tokens: [TOKEN],
		send: async (request) => { sent.push(request); if (sent.length === 1) await gate; return true; },
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval,
		now: () => 1,
	});
	publisher.set(TOKEN, "a");
	await flush();
	publisher.set(TOKEN, "b");
	publisher.set(TOKEN, "c");
	release();
	await flush();
	await flush();
	assert.deepEqual(sent.map((request) => (request.params.tokens as Record<string, string | null>)[TOKEN]), ["a", "c"]);
});

test("dispose clears a shown token and stops the refresh", async () => {
	const { sent, timers, publisher } = setup();
	publisher.set(TOKEN, "↳ explore");
	await flush();
	await publisher.dispose();
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: null });
	assert.equal(timers.count(), 0);
	publisher.set(TOKEN, "late");
	await flush();
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: null }, "nothing is sent after dispose");
});

test("dispose unsets every declared token at once", async () => {
	const { sent, timers, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(TOKEN, "↳ explore");
	publisher.set(PHASE_TOKEN, "checking");
	await flush();
	await publisher.dispose();
	assert.deepEqual(sent.at(-1)!.params.tokens, { [TOKEN]: null, [PHASE_TOKEN]: null });
	assert.equal(sent.at(-1)!.params.ttl_ms, undefined);
	assert.equal(timers.count(), 0);
});

test("dispose sends nothing when no token is shown", async () => {
	const { sent, timers, publisher } = setup([TOKEN, PHASE_TOKEN]);
	publisher.set(TOKEN, null);
	await flush();
	assert.equal(sent.length, 1);
	await publisher.dispose();
	assert.equal(sent.length, 1, "the first report already wiped both tokens");
	assert.equal(timers.count(), 0);
});

test("socketSend writes one JSON line and resolves on the reply; a dead socket resolves false", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-"));
	const path = join(dir, "herdr.sock");
	const lines: string[] = [];
	const server = createServer((socket) => {
		socket.on("data", (data) => {
			lines.push(data.toString());
			socket.end(`${JSON.stringify({ id: "x", result: {} })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	try {
		const request = { id: "x", method: "pane.report_metadata", params: { pane_id: "p", tokens: {} } } as HerdrRequest;
		assert.equal(await socketSend(path, 500)(request), true);
		assert.equal(lines.join(""), `${JSON.stringify(request)}\n`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(await socketSend(path, 200)({ id: "y", method: "m", params: {} } as HerdrRequest), false);
});
