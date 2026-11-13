import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CHANGES_ENV,
	ChangesCounter,
	UNTRACKED_MAX_BYTES,
	changesEnabled,
	changesParts,
	changesToken,
	untrackedLines,
	type CountLines,
	type GitRun,
} from "../src/changes.ts";

const HEAD = "rev-parse --verify --quiet HEAD";
const DIFF = (base: string) => `diff --numstat ${base}`;
const STATUS = "status --porcelain=v1 --untracked-files=all -z";

/** git falso: cada comando esperado devuelve su salida; cualquier otro es un error del test. */
function fakeGit(outputs: Record<string, string | Error>) {
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		const output = outputs[key];
		if (output === undefined) throw new Error(`unexpected git call: ${key}`);
		if (output instanceof Error) throw output;
		return output;
	};
	return { run, calls };
}

/** Un repo con HEAD, sin untracked: sólo importa el numstat y el status que pida el test. */
function repo(numstat: string, outputs: Record<string, string | Error> = {}) {
	return fakeGit({
		[HEAD]: "abc123\n",
		[DIFF("abc123")]: numstat,
		[STATUS]: "",
		...outputs,
	});
}

/** Cuenta líneas por su ruta; un archivo que no está en el mapa es un error del test. */
function fakeCountLines(files: Record<string, number>) {
	const seen: string[] = [];
	const countLines: CountLines = async (path) => {
		seen.push(path);
		const lines = files[path];
		if (lines === undefined) throw new Error(`unexpected count: ${path}`);
		return lines;
	};
	return { countLines, seen };
}

/** Corre un refresco y espera el valor publicado; el guard de timeout no debe quedar colgado. */
async function measure(counter: ChangesCounter, cwd = "/repo"): Promise<string | null> {
	counter.refresh(cwd);
	return Promise.race([new Promise<string | null>((resolve) => setTimeout(() => resolve(counter.token()), 200))]);
}

test("S12: only the exact value 1 turns the token on", () => {
	assert.equal(changesEnabled({ [CHANGES_ENV]: "1" }), true);
	for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "ONE"]) {
		assert.equal(changesEnabled({ [CHANGES_ENV]: value }), false, JSON.stringify(value));
	}
});

test("S12: the token is +added -deleted with an ASCII hyphen, and null when nothing changed", () => {
	assert.equal(changesToken(120, 40), "+120 -40");
	assert.equal(changesToken(5, 0), "+5 -0", "a zero part is still shown");
	assert.equal(changesToken(0, 7), "+0 -7");
	assert.equal(changesToken(0, 0), null, "no changes, no token");
});

test("S16: the token splits into the added and the deleted half, one cell each", () => {
	assert.deepEqual(changesParts(changesToken(120, 40)), { added: "+120", deleted: "-40" });
	assert.deepEqual(changesParts(changesToken(5, 0)), { added: "+5", deleted: "-0" }, "a zero part is still shown");
	assert.deepEqual(changesParts(changesToken(0, 7)), { added: "+0", deleted: "-7" });
	assert.equal(changesParts(null), null, "no changes, no halves");
	// Cualquier otra forma no se adivina: se devuelve null y no se pinta a medias.
	for (const other of ["", "+120", "120 -40", "+120-40", "+120 -40 ", "−120 −40"]) {
		assert.equal(changesParts(other), null, JSON.stringify(other));
	}
});

test("S12: sums every numstat row against HEAD and ignores binary rows", async () => {
	const git = repo("100\t40\tsrc/a.ts\n20\t0\tsrc/b.ts\n-\t-\tlogo.png\n");
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run: git.run, onChange: (token) => tokens.push(token) });
	assert.equal(await measure(counter), "+120 -40");
	assert.deepEqual(git.calls, [HEAD, DIFF("abc123"), STATUS], "one diff against HEAD, then the file list");
	assert.deepEqual(tokens, ["+120 -40"]);
});

test("S12: only untracked (`??`) entries of the porcelain list add their lines", async () => {
	const git = repo("", {
		// `-z` separa por NUL: `M  staged.ts`, `R  nuevo.ts` + su ruta vieja, y los untracked.
		[STATUS]: "M  staged.ts\0R  nuevo.ts\0viejo.ts\0?? notas.md\0?? src/dos.ts\0",
	});
	const count = fakeCountLines({ "/repo/notas.md": 3, "/repo/src/dos.ts": 2 });
	const counter = new ChangesCounter({
		cwd: "/repo",
		run: git.run,
		countLines: count.countLines,
		onChange: () => {},
	});
	assert.equal(await measure(counter), "+5 -0", "three plus two untracked lines, nothing from tracked entries");
	assert.deepEqual(count.seen, ["/repo/notas.md", "/repo/src/dos.ts"], "each untracked is read from the cwd");
});

test("S12: a repo without commits shows no token at all", async () => {
	const git = fakeGit({ [HEAD]: new Error("fatal: Needed a single revision") });
	const counter = new ChangesCounter({ cwd: "/repo", run: git.run, onChange: () => {} });
	assert.equal(await measure(counter), null, "no HEAD, no changes line");
	assert.deepEqual(git.calls, [HEAD], "nothing else is measured without commits");
});

test("S12: a failing or hanging git reads as null, never the previous value", async () => {
	const git = repo("4\t1\ta.ts\n");
	let fail = false;
	const run: GitRun = async (args, cwd) => {
		if (fail && args[0] === "diff") throw new Error("fatal: not a git repository");
		return git.run(args, cwd);
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	assert.equal(await measure(counter), "+4 -1");
	fail = true;
	assert.equal(await measure(counter), null, "an error clears the token instead of keeping it");
	assert.deepEqual(tokens, ["+4 -1", null]);

	const hanging: GitRun = () => new Promise(() => {});
	const stuck = new ChangesCounter({ cwd: "/repo", run: hanging, timeoutMs: 10, onChange: () => {} });
	assert.equal(await measure(stuck), null, "a git that never answers times out");
});

test("S12: at most one measurement in flight, plus exactly one queued re-measurement", async () => {
	let release: (() => void) | undefined;
	let waitOnce = true;
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key === HEAD) return "abc123\n";
		if (key.startsWith("diff --numstat")) {
			if (waitOnce) {
				waitOnce = false;
				await new Promise<void>((resolve) => { release = resolve; });
			}
			return "7\t2\ta.ts\n";
		}
		if (key === STATUS) return "";
		throw new Error(`unexpected git call: ${key}`);
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	counter.refresh("/repo");
	assert.equal(calls.filter((call) => call === HEAD).length, 1);
	for (let i = 0; i < 5; i++) counter.refresh("/repo");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.filter((call) => call === HEAD).length, 1, "events during a measurement never start another one");
	release?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.filter((call) => call === HEAD).length, 2, "they collapse into exactly one more");
	assert.equal(counter.token(), "+7 -2");
	assert.deepEqual(tokens, ["+7 -2", "+7 -2"], "each finished measurement publishes");
});

test("S12: a disposed counter publishes nothing more", async () => {
	let release: (() => void) | undefined;
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		if (key === HEAD) return "abc123\n";
		if (key.startsWith("diff --numstat")) {
			await new Promise<void>((resolve) => { release = resolve; });
			return "3\t0\ta.ts\n";
		}
		return "";
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	counter.refresh("/repo");
	counter.dispose();
	release?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(tokens, [], "shutdown drops the result instead of publishing it");
	assert.equal(counter.token(), null);
});

// --- Contador de untracked: misma regla que Gentle Shell (stat, tope 1 MiB, split por \n).

test("S12/PRESERVE: line counting is exactly Gentle Shell's split rule", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-lines-"));
	try {
		const file = (name: string, content: string | Buffer) => {
			const path = join(dir, name);
			writeFileSync(path, content);
			return path;
		};
		assert.equal(await untrackedLines(file("trailing.txt", "uno\ndos\ntres\n")), 3);
		assert.equal(await untrackedLines(file("no-trailing.txt", "uno\ndos")), 2);
		assert.equal(await untrackedLines(file("empty.txt", "")), 0, "an empty file adds nothing");
		assert.equal(await untrackedLines(file("only-newline.txt", "\n")), 1);
		assert.equal(await untrackedLines(file("one.txt", "uno")), 1);
		assert.equal(await untrackedLines(join(dir, "missing.txt")), 0, "a vanished file adds nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S12: a symlink, a directory and a file over 1 MiB add no lines", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-lines-"));
	try {
		writeFileSync(join(dir, "target.txt"), "a\nb\nc\n");
		symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
		symlinkSync(join(dir, "nowhere.txt"), join(dir, "broken.txt"));
		const big = join(dir, "big.txt");
		writeFileSync(big, Buffer.alloc(UNTRACKED_MAX_BYTES + 1, 0x61));
		const exact = join(dir, "exact.txt");
		writeFileSync(exact, "a\n".repeat(UNTRACKED_MAX_BYTES / 2));
		assert.equal(await untrackedLines(join(dir, "link.txt")), 0, "a symlink is not a regular file");
		assert.equal(await untrackedLines(join(dir, "broken.txt")), 0, "a broken symlink neither");
		assert.equal(await untrackedLines(dir), 0, "a directory is not a regular file");
		assert.equal(await untrackedLines(big), 0, "one byte over the cap adds nothing");
		assert.equal(await untrackedLines(exact), UNTRACKED_MAX_BYTES / 2, "exactly at the cap is still counted");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** git disponible en la máquina: sin él el test de integración se salta. */
function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("S12: integration: a real temp repo counts staged, unstaged and untracked lines", async (t) => {
	if (!hasGit()) {
		t.skip("git is not installed");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-changes-"));
	const clean = mkdtempSync(join(tmpdir(), "pi-herdr-status-changes-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	try {
		git("init", "-q", "-b", "main");
		writeFileSync(join(dir, "tracked.txt"), "uno\ndos\ntres\n");
		git("add", "tracked.txt");
		git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
		writeFileSync(join(dir, "tracked.txt"), "uno\ndos\ntres\ncuatro\ncinco\n");
		writeFileSync(join(dir, "new.txt"), "a\nb\n");
		writeFileSync(join(dir, "big.txt"), Buffer.alloc(UNTRACKED_MAX_BYTES + 1, 0x61));
		symlinkSync(join(dir, "new.txt"), join(dir, "link.txt"));
		const counter = new ChangesCounter({ cwd: dir, onChange: () => {} });
		assert.equal(await measure(counter, dir), "+4 -0", "two added lines plus two untracked; big and symlink add none");

		// Repo sin commits: no hay HEAD, así que no hay token.
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: clean, stdio: "ignore" });
		writeFileSync(join(clean, "first.txt"), "x\ny\nz\n");
		execFileSync("git", ["add", "first.txt"], { cwd: clean, stdio: "ignore" });
		const empty = new ChangesCounter({ cwd: clean, onChange: () => {} });
		assert.equal(await measure(empty, clean), null, "no commits, no changes line");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(clean, { recursive: true, force: true });
	}
});
