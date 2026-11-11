import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, type HerdrStatusConfig } from "../src/config.ts";
import {
	BACKUP_SUFFIX,
	BEGIN_MARK,
	END_MARK,
	HERDR_BIN,
	HERDR_BIN_ENV,
	HERDR_CONFIG_ENV,
	PALETTE,
	herdrBin,
	herdrConfigPath,
	managedBlock,
	nodeHerdrFs,
	planSync,
	renderRows,
	sidebarRows,
	syncHerdrRows,
	type HerdrFs,
	type HerdrRun,
	type RowCell,
	type SidebarRow,
	type StyledCell,
} from "../src/herdr-config.ts";

/** Todo test trabaja en un directorio temporal, nunca en el config real de Herdr. */
async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-herdr-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** El archivo tal como lo dejó la instalación a mano de T18 (S16: caso de migración). */
const LEGACY = `[ui.sound]
enabled = true

# pi-herdr-status: muestra el subagente activo en paneles de Pi (filas por defecto + $subagent)
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["$name", "$phase", "$changes"], ["$subagent"], ["$jobs"]]
`;

/** La celda estilada de un token, o undefined cuando la fila usa un string simple. */
function styled(rows: SidebarRow[], token: string): StyledCell | undefined {
	for (const row of rows) {
		for (const value of row) {
			if (typeof value === "object" && value.token === token) return value;
		}
	}
	return undefined;
}

/** Todas las celdas de todas las filas, sin distinguir de qué fila salieron. */
function cells(rows: SidebarRow[]): RowCell[] {
	return rows.flat();
}

/**
 * fs real con un gancho: después de escribir el temporal, otra persona edita el config.
 * Así el test cae justo en la ventana entre escribir el temporal y renombrarlo.
 */
function fsEditingAfterTemporaryWrite(configPath: string, concurrent: string): HerdrFs {
	return {
		...nodeHerdrFs,
		writeFile(path, content) {
			nodeHerdrFs.writeFile(path, content);
			if (path !== configPath) writeFileSync(configPath, concurrent);
		},
	};
}

/** Runner falso: registra cada invocación y responde lo que el test pida. */
function fakeHerdr(options: { check?: boolean; reload?: boolean; output?: string } = {}) {
	const calls: Array<{ file: string; args: string[] }> = [];
	const run: HerdrRun = async (file, args) => {
		calls.push({ file, args: [...args] });
		const ok = args[1] === "check" ? options.check ?? true : options.reload ?? true;
		return { ok, output: options.output ?? "" };
	};
	return { calls, run };
}

const withColors = (overrides: Partial<HerdrStatusConfig> = {}): HerdrStatusConfig =>
	({ ...DEFAULT_CONFIG, colors: true, ...overrides });

test("S16: with colors off every cell is a plain token string, in the order Herdr expects", () => {
	const rows = sidebarRows(DEFAULT_CONFIG);
	assert.deepEqual(rows, [
		["state_icon", "machine", "workspace", "tab"],
		["$name", "$phase"],
		["$subagent"],
		["$jobs"],
	]);
	assert.ok(cells(rows).every((cell) => typeof cell === "string"), "no style tables with colors off");
	assert.equal(
		renderRows(rows),
		'[["state_icon", "machine", "workspace", "tab"], ["$name", "$phase"], ["$subagent"], ["$jobs"]]',
		"the rows render as the TOML value the user already had",
	);
});

test("S16: $changes joins the name row only when the counter is on", () => {
	const rows = sidebarRows({ ...DEFAULT_CONFIG, changes: true });
	assert.deepEqual(rows[1], ["$name", "$phase", "$changes"], "$changes goes next to the name, like in the sidebar");
});

test("S16: a switched-off token row is omitted, and colors off keeps the rest as strings", () => {
	const noSubagent = sidebarRows({ ...DEFAULT_CONFIG, showSubagent: false });
	assert.deepEqual(noSubagent, [
		["state_icon", "machine", "workspace", "tab"],
		["$name", "$phase"],
		["$jobs"],
	]);
	const noJobs = sidebarRows({ ...DEFAULT_CONFIG, showJobs: false });
	assert.deepEqual(noJobs, [
		["state_icon", "machine", "workspace", "tab"],
		["$name", "$phase"],
		["$subagent"],
	]);
	const neither = sidebarRows({ ...DEFAULT_CONFIG, showSubagent: false, showJobs: false });
	assert.deepEqual(neither, [["state_icon", "machine", "workspace", "tab"], ["$name", "$phase"]]);
});

test("S16: with colors on $name stays a plain token and the other cells become style tables", () => {
	const rows = sidebarRows(withColors());
	assert.deepEqual(rows[1][0], "$name", "$name is never colored");
	const phase = styled(rows, "$phase");
	assert.ok(phase, "$phase is a style table");
	assert.equal(phase.fg, undefined, "the phase color comes from its rules, not from a fixed fg");
	assert.deepEqual(styled(rows, "$subagent"), { token: "$subagent", fg: PALETTE.sky });
	assert.deepEqual(styled(rows, "$jobs"), { token: "$jobs", fg: PALETTE.overlay });
});

test("S16: the $changes cell uses a neutral fg, because a colour per sign is not possible", () => {
	const rows = sidebarRows(withColors({ changes: true }));
	assert.deepEqual(styled(rows, "$changes"), { token: "$changes", fg: PALETTE.neutral });
});

test("S16: the phase rules cover every ODD phase, case-insensitively, with the Mocha palette", () => {
	const phase = styled(sidebarRows(withColors()), "$phase");
	assert.ok(phase?.rules, "the phase cell carries rules");
	const byPhase = new Map(phase.rules.map((rule) => [rule.contains, rule.fg]));
	assert.deepEqual([...byPhase.entries()], [
		["exploring", PALETTE.blue],
		["researching", PALETTE.blue],
		["planning", PALETTE.mauve],
		["deciding", PALETTE.mauve],
		["authorizing", PALETTE.mauve],
		["implementing", PALETTE.yellow],
		["checking", PALETTE.green],
		["closing", PALETTE.overlay],
	]);
	assert.ok(phase.rules.every((rule) => rule.ignore_case === true), "contains matches either phase style");
	assert.ok(phase.rules.length <= 16, "Herdr accepts at most 16 rules per token");
});

test("S16: the palette is the Catppuccin Mocha hex set the docs accept", () => {
	assert.deepEqual(PALETTE, {
		blue: "#89b4fa",
		mauve: "#cba6f7",
		yellow: "#f9e2af",
		green: "#a6e3a1",
		overlay: "#7f849c",
		sky: "#89dceb",
		neutral: "#cdd6f4",
	});
});

test("S16: the colored rows render as valid Herdr inline tables with rules", () => {
	assert.equal(
		renderRows(sidebarRows(withColors())),
		'[["state_icon", "machine", "workspace", "tab"], ["$name", { token = "$phase", rules = [{ contains = "exploring", ignore_case = true, fg = "#89b4fa" }, { contains = "researching", ignore_case = true, fg = "#89b4fa" }, { contains = "planning", ignore_case = true, fg = "#cba6f7" }, { contains = "deciding", ignore_case = true, fg = "#cba6f7" }, { contains = "authorizing", ignore_case = true, fg = "#cba6f7" }, { contains = "implementing", ignore_case = true, fg = "#f9e2af" }, { contains = "checking", ignore_case = true, fg = "#a6e3a1" }, { contains = "closing", ignore_case = true, fg = "#7f849c" }] }], [{ token = "$subagent", fg = "#89dceb" }], [{ token = "$jobs", fg = "#7f849c" }]]',
	);
});

test("S16: the managed block is marked with BEGIN and END and holds the rows_by_agent table", () => {
	assert.equal(
		managedBlock(DEFAULT_CONFIG),
		`${BEGIN_MARK}
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["$name", "$phase"], ["$subagent"], ["$jobs"]]
${END_MARK}`,
	);
	assert.equal(BEGIN_MARK, "# BEGIN pi-herdr-status (managed; do not edit)");
	assert.equal(END_MARK, "# END pi-herdr-status");
});

test("S16: the Herdr config path comes from the injected env, HERDR_CONFIG_PATH first", () => {
	assert.equal(herdrConfigPath({ HOME: "/home/u" }), join("/home/u", ".config", "herdr", "config.toml"));
	assert.equal(
		herdrConfigPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg" }),
		join("/xdg", "herdr", "config.toml"),
		"XDG wins over HOME",
	);
	assert.equal(
		herdrConfigPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg", [HERDR_CONFIG_ENV]: "/custom/config.toml" }),
		"/custom/config.toml",
		"the explicit path wins over both",
	);
	assert.equal(HERDR_CONFIG_ENV, "HERDR_CONFIG_PATH");
});

test("S16: the Herdr binary is HERDR_BIN_PATH when set, herdr otherwise", () => {
	assert.equal(herdrBin({}), HERDR_BIN);
	assert.equal(HERDR_BIN, "herdr");
	assert.equal(herdrBin({ [HERDR_BIN_ENV]: "  " }), "herdr", "a blank variable falls back");
	assert.equal(herdrBin({ [HERDR_BIN_ENV]: "/opt/herdr" }), "/opt/herdr");
	assert.equal(HERDR_BIN_ENV, "HERDR_BIN_PATH");
});

test("S16: an existing managed block is replaced and the rest of the file is kept", () => {
	const current = `[ui.sound]
enabled = true

${managedBlock({ ...DEFAULT_CONFIG, changes: true })}
[ui.toast]
delivery = "off"
`;
	const plan = planSync(current, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "replace");
	if (plan.status !== "replace") return;
	assert.equal(
		plan.content,
		`[ui.sound]
enabled = true

${managedBlock(DEFAULT_CONFIG)}
[ui.toast]
delivery = "off"
`,
		"one block, new rows, everything else byte for byte",
	);
});

test("S16: the hand-written row is migrated only when the pi-herdr-status comment marks it", () => {
	const plan = planSync(LEGACY, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "replace");
	if (plan.status !== "replace") return;
	assert.equal(
		plan.content,
		`[ui.sound]
enabled = true

${managedBlock(DEFAULT_CONFIG)}
`,
		"the comment, the table and the pi line become the managed block",
	);
	assert.ok(!plan.content.includes("muestra el subagente"), "the old comment is gone");
});

test("S16: a file without the table gets the block appended at the end", () => {
	const plan = planSync("[ui.sound]\nenabled = true\n", managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "replace");
	if (plan.status !== "replace") return;
	assert.equal(plan.content, `[ui.sound]\nenabled = true\n\n${managedBlock(DEFAULT_CONFIG)}\n`);
	const empty = planSync("", managedBlock(DEFAULT_CONFIG));
	assert.equal(empty.status, "replace");
	if (empty.status !== "replace") return;
	assert.equal(empty.content, `${managedBlock(DEFAULT_CONFIG)}\n`);
});

test("S16: an unmanaged rows_by_agent table is never migrated", () => {
	const foreign = `[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "agent"]]
pi = [["state_icon", "agent"]]
`;
	const plan = planSync(foreign, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "denied");
	if (plan.status !== "denied") return;
	assert.match(plan.reason, /rows_by_agent/u, "the reason names the table that blocks the sync");
});

test("S16: a pi line without the pi-herdr-status comment is not ours either", () => {
	const unmarked = `[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "agent"]]
`;
	const plan = planSync(unmarked, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "denied");

	const otherComment = `# my own row
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "agent"]]
`;
	assert.equal(planSync(otherComment, managedBlock(DEFAULT_CONFIG)).status, "denied");
});

test("S16: the marked table with other keys is not migrated", () => {
	const extraKeys = `# pi-herdr-status: mine
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon"]]
claude = [["state_icon"]]
`;
	const plan = planSync(extraKeys, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "denied");
	if (plan.status !== "denied") return;
	assert.match(plan.reason, /rows_by_agent/u);
});

test("S16: an incomplete managed block is refused instead of guessed", () => {
	const partial = `[ui.sound]
enabled = true
${BEGIN_MARK}
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon"]]
`;
	const plan = planSync(partial, managedBlock(DEFAULT_CONFIG));
	assert.equal(plan.status, "denied");
	if (plan.status !== "denied") return;
	assert.ok(plan.reason.length > 0);
});

test("S16: a missing Herdr config is an error and is never created", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "herdr", "config.toml");
		const herdr = fakeHerdr();
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "error");
		assert.equal(result.path, path);
		assert.ok(result.reason?.length, "the error explains itself");
		assert.equal(existsSync(path), false, "nothing is created");
		assert.equal(existsSync(join(dir, "herdr")), false, "not even the directory");
		assert.deepEqual(herdr.calls, [], "herdr is never invoked");
	});
});

test("S16: a successful sync backs up, writes the block and reloads only after the check", async () => {
	const original = "[ui.sound]\nenabled = true\n";
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, original);
		const herdr = fakeHerdr();
		const result = await syncHerdrRows({
			config: withColors({ changes: true }),
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "ok");
		assert.deepEqual(herdr.calls.map((call) => [call.file, call.args]), [
			["herdr", ["config", "check"]],
			["herdr", ["server", "reload-config"]],
		], "check first, then the reload");
		assert.equal(readFileSync(`${path}${BACKUP_SUFFIX}`, "utf8"), original, "the backup is the previous file");
		const written = readFileSync(path, "utf8");
		assert.ok(written.startsWith("[ui.sound]\nenabled = true\n"), "the rest of the file is untouched");
		assert.match(written, /# BEGIN pi-herdr-status \(managed; do not edit\)/u);
		assert.match(written, /fg = "#89dceb"/u, "the colors of the config are in the block");
		assert.match(written, /"\$changes"/u);
		assert.deepEqual(readdirSync(dir), ["config.toml", `config.toml${BACKUP_SUFFIX}`], "no temporary file left");
	});
});

test("S16: HERDR_BIN_PATH picks the binary the sync calls", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, "");
		const herdr = fakeHerdr();
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path, [HERDR_BIN_ENV]: "/opt/herdr" },
			run: herdr.run,
		});
		assert.equal(result.status, "ok");
		assert.deepEqual(herdr.calls.map((call) => call.file), ["/opt/herdr", "/opt/herdr"]);
	});
});

test("S16: a failed config check restores the previous file byte for byte and does not reload", async () => {
	const original = `[ui.sound]
enabled = false
`;
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, original);
		const herdr = fakeHerdr({ check: false, output: "unknown key" });
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "error");
		assert.match(result.reason ?? "", /config check/u);
		assert.match(result.reason ?? "", /unknown key/u, "the check output is reported");
		assert.equal(readFileSync(path, "utf8"), original, "the file is back to what it was");
		assert.deepEqual(herdr.calls.map((call) => call.args.join(" ")), ["config check"], "no reload after a failure");
	});
});

test("S16: a denied sync writes nothing, leaves no backup and never calls herdr", async () => {
	const foreign = `[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon"]]
`;
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, foreign);
		const herdr = fakeHerdr();
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "denied");
		assert.equal(readFileSync(path, "utf8"), foreign, "byte for byte");
		assert.equal(existsSync(`${path}${BACKUP_SUFFIX}`), false, "no backup either");
		assert.deepEqual(herdr.calls, []);
	});
});

test("S16: syncing twice keeps a single block and follows the config", async () => {
	const original = LEGACY;
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, original);
		const herdr = fakeHerdr();
		const env = { [HERDR_CONFIG_ENV]: path };
		assert.equal((await syncHerdrRows({ config: DEFAULT_CONFIG, env, run: herdr.run })).status, "ok");
		assert.equal((await syncHerdrRows({ config: withColors(), env, run: herdr.run })).status, "ok");
		const written = readFileSync(path, "utf8");
		assert.equal(written.match(/# BEGIN pi-herdr-status/g)?.length, 1, "one managed block");
		assert.equal(written.match(/# END pi-herdr-status/g)?.length, 1);
		assert.match(written, /fg = "#89dceb"/u, "the second sync rewrote the rows with colors");
		assert.ok(!written.includes("muestra el subagente"), "the old hand-written comment is gone");
	});
});

test("S16: a reload failure is reported as an error without touching the checked file", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, "[ui.sound]\nenabled = true\n");
		const herdr = fakeHerdr({ reload: false, output: "no server" });
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "error");
		assert.match(result.reason ?? "", /reload-config/u);
		assert.match(readFileSync(path, "utf8"), /# BEGIN pi-herdr-status/u, "the checked config stays in place");
	});
});

test("S16 R1: the sync keeps the mode of the original file even with umask 022", async () => {
	const original = "[ui.sound]\nenabled = true\n";
	const previousUmask = process.umask(0o022);
	try {
		await withTempDir(async (dir) => {
			const path = join(dir, "config.toml");
			writeFileSync(path, original);
			// writeFileSync ya aplica el umask, así que el modo se fija a mano.
			chmodSync(path, 0o664);
			assert.equal(statSync(path).mode & 0o777, 0o664, "the test starts from a 664 file");
			const herdr = fakeHerdr();
			const result = await syncHerdrRows({
				config: DEFAULT_CONFIG,
				env: { [HERDR_CONFIG_ENV]: path },
				run: herdr.run,
			});
			assert.equal(result.status, "ok");
			assert.equal(statSync(path).mode & 0o777, 0o664, "the written file keeps the original permissions");
		});
	} finally {
		process.umask(previousUmask);
	}
});

test("S16 R2: a second sync never overwrites the backup of the first one", async () => {
	const original = LEGACY;
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		const backup = `${path}${BACKUP_SUFFIX}`;
		writeFileSync(path, original);
		const herdr = fakeHerdr();
		const env = { [HERDR_CONFIG_ENV]: path };
		assert.equal((await syncHerdrRows({ config: DEFAULT_CONFIG, env, run: herdr.run })).status, "ok");
		assert.equal(readFileSync(backup, "utf8"), original, "the backup keeps the version before the first sync");
		assert.equal((await syncHerdrRows({ config: withColors(), env, run: herdr.run })).status, "ok");
		assert.equal(readFileSync(backup, "utf8"), original, "the second sync leaves the backup alone");
		assert.match(readFileSync(path, "utf8"), /fg = "#89dceb"/u, "the config itself did follow the second sync");
	});
});

test("S16 R2: a failed check restores the bytes of this sync, not whatever the backup holds", async () => {
	const original = "[ui.sound]\nenabled = false\n";
	const stale = "# an older version from the first sync\n";
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		const backup = `${path}${BACKUP_SUFFIX}`;
		writeFileSync(path, original);
		writeFileSync(backup, stale);
		const herdr = fakeHerdr({ check: false, output: "unknown key" });
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run: herdr.run,
		});
		assert.equal(result.status, "error");
		assert.equal(readFileSync(path, "utf8"), original, "the in-memory copy of this sync is what comes back");
		assert.equal(readFileSync(backup, "utf8"), stale, "the existing backup is never touched");
	});
});

test("S16 R3: an edit made before the rename is never overwritten", async () => {
	const original = "[ui.sound]\nenabled = true\n";
	const concurrent = "# someone else edited this during the sync\n";
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		writeFileSync(path, original);
		const herdr = fakeHerdr();
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			fs: fsEditingAfterTemporaryWrite(path, concurrent),
			run: herdr.run,
		});
		assert.equal(result.status, "error");
		assert.match(result.reason ?? "", /changed/u, "the error says the file changed during the sync");
		assert.match(result.reason ?? "", /nothing was written/u);
		assert.equal(readFileSync(path, "utf8"), concurrent, "the concurrent edit survives");
		assert.equal(existsSync(`${path}${BACKUP_SUFFIX}`), false, "no backup for a sync that never wrote");
		assert.deepEqual(readdirSync(dir), ["config.toml"], "no temporary file left");
		assert.deepEqual(herdr.calls, [], "herdr is not invoked either");
	});
});

test("S16 R3: a failed check does not restore over an edit made during the check", async () => {
	const original = "[ui.sound]\nenabled = true\n";
	const concurrent = "# edited while herdr was checking\n";
	await withTempDir(async (dir) => {
		const path = join(dir, "config.toml");
		const backup = `${path}${BACKUP_SUFFIX}`;
		writeFileSync(path, original);
		const run: HerdrRun = async (_file, args) => {
			if (args[1] === "check") writeFileSync(path, concurrent);
			return { ok: false, output: "unknown key" };
		};
		const result = await syncHerdrRows({
			config: DEFAULT_CONFIG,
			env: { [HERDR_CONFIG_ENV]: path },
			run,
		});
		assert.equal(result.status, "error");
		assert.match(result.reason ?? "", /not restored/u);
		assert.match(result.reason ?? "", /edited/u, "the error names the concurrent edit as the reason");
		assert.ok((result.reason ?? "").includes(backup), "the error points at the backup");
		assert.equal(readFileSync(path, "utf8"), concurrent, "the concurrent edit is left alone");
		assert.equal(readFileSync(backup, "utf8"), original, "the backup keeps the original");
	});
});
