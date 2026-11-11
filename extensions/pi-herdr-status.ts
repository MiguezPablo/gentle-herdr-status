/**
 * pi-herdr-status: shows the running subagent, what the orchestrator is doing and the
 * jobs it launched in the Herdr sidebar, as the `$name` token (`gentle`), the `$phase`
 * token (a gentle-pi ODD phase in square brackets, such as `[exploring]`, else
 * `[working]`), the `$subagent` token (`↳ explore` or `↳ worker (+2)`) and the `$jobs`
 * token (`⏵ CI for PR 1834` or `⏵ logs (+1)`) and, opt-in, the `$changes` token
 * (`+120 -40`, the uncommitted lines of the session's git repo).
 *
 * Everything is configurable in a JSON file (`src/config.ts`) and, from the TUI, with
 * `/herdr-status`: one `style` for the whole sidebar (`plain` or `emoji`, never per
 * section), whether `$changes` is measured, whether the `$subagent` and `$jobs` tokens are
 * published at all, the panel name and whether the managed row in Herdr's own `config.toml`
 * carries colors. The plain style is `[exploring]`, `↳ explore` and `⏵ build`; the emoji one
 * is `🔍 exploring`, `🧭 explore` and `🔄 build`. Saving the panel writes the file and applies
 * it at once: the extension rereads the config and republishes every token, without
 * waiting for the next Pi event. Escape cancels and writes nothing. The "Sync Herdr rows"
 * action saves the same draft and then writes the `pi` row inside a
 * `# BEGIN pi-herdr-status …` block of Herdr's config (`src/herdr-config.ts`), checking and
 * reloading Herdr; a row written by someone else is never touched. The panel describes the
 * selected row under the list (one line per row, from `src/config.ts`), so each option
 * says what it does and what its value renders.
 *
 * The environment still wins over the file for the two variables that existed before it
 * (`PI_HERDR_STATUS_STYLE`, `PI_HERDR_STATUS_CHANGES`); the panel shows those options as
 * forced and does not edit them. `PI_HERDR_STATUS_STYLE` forces the single style.
 *
 * Only presentation metadata (`pane.report_metadata`). Pane state
 * (working/blocked/idle) and desktop notifications stay with Herdr's official
 * Pi integration and Herdr's own [ui.toast]/[ui.sound] settings, so this
 * extension never reports state, never reacts to UI prompts and never notifies.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";

import { ChangesCounter, type GitRun } from "../src/changes.ts";
import {
	ACTION_IDS,
	actionRows,
	applyName,
	configFilePath,
	cycleOption,
	DEFAULT_CONFIG,
	describeConfig,
	effectiveConfig,
	loadConfig,
	OPTION_IDS,
	optionRows,
	saveConfig,
	type ActionRow,
	type ForcedOptions,
	type HerdrStatusConfig,
	type OptionRow,
} from "../src/config.ts";
import { createDebug, type DebugWriter } from "../src/debug.ts";
import { syncHerdrRows, type HerdrFs, type HerdrRun } from "../src/herdr-config.ts";
import {
	CHANGES_TOKEN,
	JOBS_TOKEN,
	MetadataPublisher,
	NAME_TOKEN,
	PHASE_TOKEN,
	TOKEN,
	herdrPane,
	socketSend,
	type Env,
	type PublisherOptions,
	type Send,
} from "../src/herdr.ts";
import { JOBS_SIDEBAR_EVENT, JobsTracker } from "../src/jobs.ts";
import { phaseToken, readOddPhase, type PhaseReader } from "../src/phase.ts";
import { SubagentTracker } from "../src/tracker.ts";

/** gentle-pi's content-free notification bus; subagent status changes carry taskId and status. */
export const STATUS_CHANNEL = "gentle-pi:notification:source";

export type ExtensionDeps = {
	env?: Env;
	send?: Send;
	setInterval?: PublisherOptions["setInterval"];
	clearInterval?: PublisherOptions["clearInterval"];
	/** Replaces gentle-pi's ODD phase registry (tests). */
	readPhase?: PhaseReader;
	/** Replaces the opt-in diagnostic writer (tests); by default it reads `PI_HERDR_STATUS_DEBUG`. */
	debug?: DebugWriter;
	/** Replaces the git runner of the opt-in `$changes` counter (tests); by default it runs git. */
	runGit?: GitRun;
	/** Replaces the filesystem of the Herdr config sync (tests); by default it uses the real one. */
	herdrFs?: HerdrFs;
	/** Replaces the `herdr` runner of the config sync (tests); by default it runs the binary. */
	herdrRun?: HerdrRun;
};

type Ctx = {
	mode?: string;
	cwd?: unknown;
	sessionManager?: { getSessionId?: () => string };
} | undefined;
type ToolEvent = { toolCallId?: unknown; toolName?: unknown; input?: unknown; details?: unknown };

/** ctrl+s guarda desde cualquier fila, sin tener que llegar hasta `Save changes`. */
const SAVE_KEY = "\u0013";
const BACKSPACE_KEYS: ReadonlySet<string> = new Set(["\u007f", "\b"]);

/** Lo mínimo que el panel usa de la TUI y del tema, para no depender de sus módulos. */
type PanelTui = { requestRender?(): void; invalidate?(): void };
type PanelTheme = Pick<Theme, "fg" | "bold">;
type PanelKeys = Pick<KeybindingsManager, "matches">;

type PanelOptions = {
	/** Copia editable de lo guardado: hasta guardar no se escribe nada. */
	config: HerdrStatusConfig;
	/** Config en efecto: con una opción forzada, la descripción usa el valor del env. */
	effective: HerdrStatusConfig;
	/** Opciones que una variable de entorno fija: se marcan y no se editan. */
	forced: ForcedOptions;
	theme: PanelTheme;
	keybindings: PanelKeys;
	tui: PanelTui;
	/** Cierra el panel: la config guardada con la acción elegida, o undefined cuando se cancela. */
	done: (result: PanelResult) => void;
};

/** Lo que el panel entrega: guardar sólo la config, o guardarla y sincronizar la fila de Herdr. */
export type PanelResult = { action: "save" | "sync"; config: HerdrStatusConfig } | undefined;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un recorte por caracteres visibles; el color se aplica después para no cortar una secuencia. */
function clip(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = Array.from(text);
	return chars.length <= width ? text : `${chars.slice(0, width - 1).join("")}…`;
}

/** Corta un texto en líneas de ancho visible, sin partir palabras salvo que no entren. */
function wrapLine(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ").filter((part) => part.length > 0)) {
		const candidate = line === "" ? word : `${line} ${word}`;
		if (Array.from(candidate).length <= width) {
			line = candidate;
			continue;
		}
		if (line !== "") lines.push(line);
		line = word;
	}
	if (line !== "") lines.push(line);
	return lines.map((each) => clip(each, width));
}

/** Un carácter escribible: el panel no interpreta teclas de control como texto. */
function printable(data: string): boolean {
	return data.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(data);
}

/**
 * Panel del `/herdr-status`: una fila por opción más la de guardar. Se mueve con las
 * flechas, Enter cicla el valor de la fila (o entra y confirma la edición del nombre),
 * ctrl+s guarda y Esc cancela sin escribir. No escribe nada por sí mismo: devuelve la
 * config editada a quien lo abrió.
 */
class SettingsPanel {
	private readonly deps: PanelOptions;
	private config: HerdrStatusConfig;
	private cursor = 0;
	/** Texto en edición del nombre; undefined cuando la fila no se está editando. */
	private editing: string | undefined;
	private message: string | undefined;

	constructor(options: PanelOptions) {
		this.deps = options;
		this.config = options.config;
	}

	/**
	 * Una fila por opción más las dos acciones. La descripción de la fila seleccionada va
	 * debajo de la lista, en gris, como en el panel de /tokometer.
	 */
	render(width: number): string[] {
		const theme = this.deps.theme;
		const rows = optionRows(this.config, this.deps.forced, this.deps.effective);
		const actions = actionRows();
		const lines = [theme.fg("accent", theme.bold(clip("pi-herdr-status", width)))];
		rows.forEach((row, index) => {
			const selected = index === this.cursor;
			const editing = row.id === "name" && this.editing !== undefined;
			const value = editing ? `${this.editing}▏` : row.value;
			const forced = row.forcedBy === undefined ? "" : `  (forzado por ${row.forcedBy})`;
			const line = clip(`${selected ? "› " : "  "}${row.label}: ${value}${forced}`, width);
			lines.push(selected ? theme.fg("accent", line) : line);
		});
		actions.forEach((action, index) => {
			const selected = this.cursor === rows.length + index;
			const line = clip(`${selected ? "› " : "  "}${action.label}`, width);
			lines.push(selected ? theme.fg("accent", line) : line);
		});
		const description = this.selectedDescription(rows, actions);
		if (description !== undefined) {
			lines.push("");
			for (const part of wrapLine(description, width - 2)) {
				lines.push(theme.fg("dim", clip(`  ${part}`, width)));
			}
		}
		lines.push(theme.fg("dim", clip("↑↓ move · Enter change · ctrl+s save · Esc cancel", width)));
		if (this.editing !== undefined) {
			lines.push(theme.fg("dim", clip("Panel name: Enter keep · Esc discard", width)));
		}
		if (this.message !== undefined) lines.push(theme.fg("warning", clip(this.message, width)));
		return lines;
	}

	handleInput(data: string): void {
		if (this.editing !== undefined) {
			this.editName(data);
			this.refresh();
			return;
		}
		if (data === SAVE_KEY) {
			this.deps.done({ action: "save", config: this.config });
			return;
		}
		if (this.deps.keybindings.matches(data, "tui.select.cancel")) {
			this.deps.done(undefined);
			return;
		}
		if (this.deps.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (this.deps.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (this.deps.keybindings.matches(data, "tui.select.confirm")) {
			this.confirm();
		}
		this.refresh();
	}

	invalidate(): void {}

	/** Una fila por opción más las de guardar y sincronizar. */
	private get rowCount(): number {
		return OPTION_IDS.length + ACTION_IDS.length;
	}

	/** La descripción de la fila donde está el cursor, sea una opción o una acción. */
	private selectedDescription(
		rows: readonly OptionRow[],
		actions: readonly ActionRow[],
	): string | undefined {
		if (this.cursor < rows.length) return rows[this.cursor].description;
		return actions[this.cursor - rows.length]?.description;
	}

	private move(delta: number): void {
		this.cursor = Math.min(this.rowCount - 1, Math.max(0, this.cursor + delta));
	}

	private confirm(): void {
		const rows = optionRows(this.config, this.deps.forced, this.deps.effective);
		if (this.cursor >= rows.length) {
			const action = actionRows()[this.cursor - rows.length];
			this.deps.done({ action: action.id, config: this.config });
			return;
		}
		const row = rows[this.cursor];
		if (row.forcedBy !== undefined) {
			this.message = `${row.label} is forced by ${row.forcedBy}`;
			return;
		}
		if (row.id === "name") {
			this.editing = this.config.name;
			this.message = undefined;
			return;
		}
		this.config = cycleOption(this.config, row.id);
		this.message = undefined;
	}

	private editName(data: string): void {
		const buffer = this.editing ?? "";
		if (this.deps.keybindings.matches(data, "tui.select.cancel")) {
			this.editing = undefined;
			return;
		}
		if (this.deps.keybindings.matches(data, "tui.select.confirm")) {
			this.config = applyName(this.config, buffer);
			this.editing = undefined;
			return;
		}
		if (BACKSPACE_KEYS.has(data)) {
			this.editing = [...buffer].slice(0, -1).join("");
			return;
		}
		if (printable(data)) this.editing = buffer + data;
	}

	private refresh(): void {
		this.deps.tui.invalidate?.();
		this.deps.tui.requestRender?.();
	}
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createExtension(deps: ExtensionDeps = {}) {
	return (pi: ExtensionAPI): void => {
		const env = deps.env ?? process.env;
		const herdr = herdrPane(env);
		// Gentle agents children run headless (`--mode rpc`) and must never publish.
		if (!herdr || env.GENTLE_PI_AGENTS_CHILD === "1") return;

		const path = configFilePath(env);
		const readPhase = deps.readPhase ?? readOddPhase;
		// Off by default: with `PI_HERDR_STATUS_DEBUG` unset the writer does nothing.
		const debug = deps.debug ?? createDebug({ env });

		const tracker = new SubagentTracker();
		const jobs = new JobsTracker();
		let publisher: MetadataPublisher | undefined;
		// Config en efecto: la del archivo con la precedencia del env ya aplicada.
		let settings: HerdrStatusConfig = DEFAULT_CONFIG;
		let changes: ChangesCounter | undefined;
		/** Último cwd de sesión visto: con él se mide `$changes` cuando se enciende. */
		let lastCwd: string | undefined;
		let sessionId: string | undefined;
		let working = false;

		type PhaseRead = { raw: unknown; token: string | null };

		/** `$phase`: only while the agent works, read on the turn and tool events, never polled. */
		const phase = (): PhaseRead => {
			if (!working) return { raw: null, token: null };
			if (sessionId === undefined) return { raw: null, token: phaseToken(undefined, settings.style) };
			try {
				const raw = readPhase(sessionId);
				return { raw: raw ?? null, token: phaseToken(raw, settings.style) };
			} catch {
				return { raw: null, token: phaseToken(undefined, settings.style) };
			}
		};

		/**
		 * Pi's session id as this event's ctx sees it. gentle-pi reads it fresh on every
		 * event too, so a resumed, forked or new session changes it after `session_start`
		 * and the ODD phase must be looked up under the id the event actually belongs to.
		 */
		const ctxSessionId = (ctx: unknown): string | undefined => {
			try {
				return (ctx as Ctx)?.sessionManager?.getSessionId?.();
			} catch {
				return undefined;
			}
		};

		/** Keep the last known id when an event's ctx carries none, so the lookup still works. */
		const syncSessionId = (seen: string | undefined): void => {
			sessionId = seen ?? sessionId;
		};

		/** Session cwd of this event, when its ctx reports one; else the last known one is kept. */
		const ctxCwd = (ctx: unknown): string | undefined => {
			try {
				const cwd = (ctx as Ctx)?.cwd;
				return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
			} catch {
				return undefined;
			}
		};

		/** Push every token in one report; returns what the phase lookup saw, for the diagnostic. */
		const report = (): PhaseRead => {
			const read = phase();
			// `$name` sale de la config y no depende del turno: el panel tiene nombre hasta el shutdown.
			publisher?.set(NAME_TOKEN, settings.name);
			// Un token apagado en la config nunca se publica con valor.
			publisher?.set(TOKEN, settings.showSubagent ? tracker.label(settings.style) : null);
			publisher?.set(PHASE_TOKEN, read.token);
			// `$jobs` tampoco depende del turno: un job sigue vivo sin turno en curso.
			publisher?.set(JOBS_TOKEN, settings.showJobs ? jobs.label(settings.style) : null);
			// `$changes` se publica igual que `$jobs`; con el contador apagado siempre va limpio.
			publisher?.set(CHANGES_TOKEN, changes?.token() ?? null);
			return read;
		};

		/** Dispara una medición de `$changes` sin bloquear el evento, con el cwd de su ctx. */
		const refreshChanges = (ctx: unknown): void => {
			const cwd = ctxCwd(ctx);
			if (cwd !== undefined) lastCwd = cwd;
			changes?.refresh(cwd ?? lastCwd);
		};

		/** Crea o descarta el contador según la config en efecto: apagado, git nunca corre. */
		const syncChanges = (): void => {
			if (settings.changes) {
				if (!changes) {
					changes = new ChangesCounter({
						cwd: lastCwd ?? process.cwd(),
						run: deps.runGit,
						// Una medición terminada se publica en el mismo reporte que los demás tokens.
						onChange: () => { report(); },
					});
				}
				return;
			}
			changes?.dispose();
			changes = undefined;
		};

		/** (Re)lee el archivo, aplica la precedencia del env y ajusta el contador. Sin timers. */
		const applySettings = (): void => {
			const effective = effectiveConfig(loadConfig(path), env);
			settings = effective.config;
			syncChanges();
		};

		const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
			// Se relee el archivo al abrir: pudo cambiar desde `session_start`.
			const stored = loadConfig(path);
			const effective = effectiveConfig(stored, env);
			// Sin TUI no hay panel: se informa lo que está en efecto y la ruta, sin escribir.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					`Herdr status: ${describeConfig(effective.config)}. Config file: ${path}`,
					"info",
				);
				return;
			}
			const result = await ctx.ui.custom<PanelResult>((tui, theme, keybindings, done) =>
				new SettingsPanel({
					config: stored,
					effective: effective.config,
					forced: effective.forced,
					theme,
					keybindings,
					tui,
					done,
				}));
			// Esc: se cierra sin escribir nada.
			if (result === undefined) return;
			try {
				saveConfig(path, result.config);
			} catch (error) {
				ctx.ui.notify(`Herdr status: could not save ${path} (${reason(error)})`, "error");
				return;
			}
			// Aplica en vivo: relee el archivo y republica todos los tokens al instante.
			applySettings();
			report();
			refreshChanges(undefined);
			if (result.action === "save") {
				ctx.ui.notify(`Herdr status: saved to ${path}`, "info");
				return;
			}
			// Sync: la fila de Herdr se arma con la config en efecto recién guardada.
			const sync = await syncHerdrRows({
				config: settings,
				env,
				fs: deps.herdrFs,
				run: deps.herdrRun,
			});
			if (sync.status === "ok") {
				ctx.ui.notify(`Herdr status: Herdr rows synced in ${sync.path}`, "info");
			} else if (sync.status === "denied") {
				ctx.ui.notify(`Herdr status: Herdr rows not synced, ${sync.reason}`, "warning");
			} else {
				ctx.ui.notify(`Herdr status: could not sync Herdr rows (${sync.reason})`, "error");
			}
		};

		pi.registerCommand("herdr-status", {
			description: "pi-herdr-status settings: plain/emoji style, visible tokens, panel name and Herdr rows",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				await openPanel(ctx);
			},
		});

		/** Report, then append one diagnostic line for this event (nothing when the variable is unset). */
		const publish = (
			event: "session_start" | "agent_start" | "agent_end" | "tool_call" | "tool_result",
			seen: { toolName?: string; ctxSessionId?: string } = {},
		): void => {
			if (!publisher) return;
			const read = report();
			debug({
				event,
				toolName: seen.toolName,
				ctxSessionId: seen.ctxSessionId,
				sessionId,
				rawPhase: read.raw,
				token: read.token,
			});
		};

		const off = pi.events.on(STATUS_CHANNEL, (data: unknown) => {
			if (!publisher || !record(data) || data.source !== "subagent") return;
			if (typeof data.taskId !== "string" || typeof data.status !== "string") return;
			tracker.status(data.taskId, data.status);
			report();
		});

		// Cada evento de gentle-pi reemplaza el snapshot completo de jobs de esta sesión.
		const offJobs = pi.events.on(JOBS_SIDEBAR_EVENT, (data: unknown) => {
			if (!publisher) return;
			jobs.snapshot(data, sessionId);
			report();
			// Un job cambió: pudo dejar cambios en el repo, así que se remide.
			refreshChanges(undefined);
		});

		pi.on("session_start", (_event, ctx) => {
			const context = ctx as Ctx;
			if (context?.mode !== "tui") return;
			// La config se carga acá y después de guardar; nunca con un timer.
			applySettings();
			tracker.reset();
			jobs.reset();
			changes?.reset();
			working = false;
			const seen = ctxSessionId(context);
			sessionId = seen;
			if (!publisher) {
				publisher = new MetadataPublisher({
					pane: herdr.pane,
					tokens: [NAME_TOKEN, TOKEN, PHASE_TOKEN, JOBS_TOKEN, CHANGES_TOKEN],
					send: deps.send ?? socketSend(herdr.socket),
					setInterval: deps.setInterval,
					clearInterval: deps.clearInterval,
				});
			}
			publish("session_start", { ctxSessionId: seen });
			refreshChanges(context);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!publisher) return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			working = true;
			publish("agent_start", { ctxSessionId: seen });
			refreshChanges(ctx);
		});

		pi.on("agent_end", (_event, ctx) => {
			if (!publisher || !working) return;
			working = false;
			publish("agent_end");
			refreshChanges(ctx);
		});

		pi.on("tool_call", (event, ctx) => {
			if (!publisher) return;
			const { toolCallId, toolName, input } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			tracker.toolCall(toolCallId, toolName, input);
			publish("tool_call", { toolName, ctxSessionId: seen });
		});

		pi.on("tool_result", (event, ctx) => {
			if (!publisher) return;
			const { toolCallId, toolName, details } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			tracker.toolResult(toolCallId, toolName, details);
			publish("tool_result", { toolName, ctxSessionId: seen });
			// Cubre edit/write/bash y el fin de un subagente: cualquier herramienta puede tocar el repo.
			refreshChanges(ctx);
		});

		pi.on("session_shutdown", async () => {
			if (typeof off === "function") off();
			if (typeof offJobs === "function") offJobs();
			tracker.reset();
			jobs.reset();
			changes?.dispose();
			changes = undefined;
			working = false;
			sessionId = undefined;
			const current = publisher;
			publisher = undefined;
			await current?.dispose();
		});
	};
}

export default createExtension();
