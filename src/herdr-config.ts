/**
 * Fila de este paquete en el `config.toml` de Herdr, dentro de un bloque gestionado.
 *
 * Herdr acepta, en `ui.sidebar.agents.rows_by_agent`, celdas string o tablas inline
 * `{ token, fg, bold, dim, rules }` (config-reference 0.9.5): `fg` es un color estricto
 * `#RGB`/`#RRGGBB`, `rules` son hasta 16 condiciones ordenadas (`equals`, `contains`,
 * `starts_with`, `gt`, `lt`) con `ignore_case` opcional para texto, y gana la primera
 * que coincide. Por eso los colores son parte de la config de Herdr y no un token: este
 * módulo escribe esa fila y nada más.
 *
 * Reglas de escritura, copiadas de lo que hace herdr-gentle-shell:
 * - el archivo tiene que existir: si no está, es un error y nunca se crea uno nuevo;
 * - si el bloque `# BEGIN pi-herdr-status …` / `# END pi-herdr-status` ya está, se
 *   reemplaza entero y el resto del archivo queda igual;
 * - si no hay bloque pero hay una tabla `[ui.sidebar.agents.rows_by_agent]` escrita a
 *   mano, sólo se migra cuando es exactamente la que dejó la instalación de T18 (el
 *   comentario `# pi-herdr-status:`, la tabla y una única clave `pi = …`); cualquier otra
 *   tabla es de otra persona y se niega sin escribir;
 * - la escritura es atómica (temporal + rename), conserva el modo del original y deja un
 *   backup `<config>.pi-herdr-status.bak` que se crea una sola vez y no se pisa nunca;
 * - antes del rename se relee el archivo: si alguien lo editó mientras corría el sync no se
 *   escribe nada y se informa el cambio concurrente;
 * - después corre `herdr config check`; si falla, se restaura el original leído en este sync
 *   (sólo si el archivo sigue siendo lo que este sync escribió) y se informa; sólo si pasa
 *   se recarga con `herdr server reload-config`.
 *
 * La ruta y el binario salen del `env` inyectable, así que los tests nunca tocan el
 * config real del usuario ni ejecutan herdr: fs y runner también son inyectables.
 */
import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HerdrStatusConfig } from "./config.ts";
import { CHANGES_TOKEN, JOBS_TOKEN, NAME_TOKEN, PHASE_TOKEN, TOKEN, type Env } from "./herdr.ts";

/** Ruta del config de Herdr; reemplaza a la de XDG/HOME cuando está definida. */
export const HERDR_CONFIG_ENV = "HERDR_CONFIG_PATH";
/** Binario de Herdr; por defecto `herdr`. */
export const HERDR_BIN_ENV = "HERDR_BIN_PATH";
/** Binario por defecto, el que queda en el PATH tras instalar Herdr. */
export const HERDR_BIN = "herdr";
/** Directorio del config de Herdr dentro de XDG_CONFIG_HOME (o ~/.config). */
const HERDR_CONFIG_DIR = "herdr";
const HERDR_CONFIG_FILE = "config.toml";
/** Tope de cada invocación de herdr: un binario colgado no deja el panel esperando. */
const HERDR_TIMEOUT_MS = 10_000;

/** Marca de inicio del bloque gestionado: el usuario no edita lo que está adentro. */
export const BEGIN_MARK = "# BEGIN pi-herdr-status (managed; do not edit)";
/** Marca de fin del bloque gestionado. */
export const END_MARK = "# END pi-herdr-status";
/** Sufijo del backup que se deja al lado del config antes de escribir. */
export const BACKUP_SUFFIX = ".pi-herdr-status.bak";
/** Tabla de Herdr que este paquete escribe. */
export const TABLE_HEADER = "[ui.sidebar.agents.rows_by_agent]";
/** Comentario de la fila escrita a mano por T18: sólo esa se migra (S16). */
export const LEGACY_COMMENT = "# pi-herdr-status:";
/** Agente canónico de Pi en Herdr: es la clave que se escribe en la tabla. */
const AGENT_ID = "pi";

/**
 * Paleta Catppuccin Mocha: `fg` en una celda de Herdr es un hex estricto, así que los
 * colores son constantes y no dependen del tema de Herdr.
 */
export const PALETTE = {
	blue: "#89b4fa",
	mauve: "#cba6f7",
	yellow: "#f9e2af",
	green: "#a6e3a1",
	overlay: "#7f849c",
	sky: "#89dceb",
	neutral: "#cdd6f4",
} as const;

/** Roles del tema activo de Pi que este paquete usa como `fg` (S20). */
export type ThemeRole = "text" | "toolTitle" | "accent" | "warning" | "success" | "dim" | "muted";

/**
 * Hex ya resueltos del tema activo, por rol. Los resuelve la extensión desde `ctx.ui.theme`;
 * un rol ausente o inválido hace que esa celda use su hex de `PALETTE`.
 */
export type ThemeHexes = Partial<Record<ThemeRole, string>>;

/** Un `fg` de Herdr es estricto: sólo `#RRGGBB` (S16); cualquier otra cosa cae a la paleta. */
export const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/u;

/** El hex del primer rol del tema que exista y valide; si no, el de la paleta de esa celda. */
function themeHex(hexes: ThemeHexes | undefined, roles: readonly ThemeRole[], fallback: string): string {
	for (const role of roles) {
		const value = hexes?.[role];
		if (typeof value === "string" && HEX_PATTERN.test(value)) return value;
	}
	return fallback;
}

/** Una condición de estilo de Herdr: un `contains` sobre el valor del token. */
export type StyleRule = { contains: string; ignore_case: true; fg: string };
/** Una celda con estilo propio (tabla inline de Herdr). */
export type StyledCell = { token: string; fg?: string; rules?: StyleRule[] };
/** Una celda de fila: el token tal cual, o su tabla de estilo. */
export type RowCell = string | StyledCell;
/** Una fila del sidebar de Herdr. */
export type SidebarRow = RowCell[];

/**
 * Color de cada fase (S16): se busca con `contains` e `ignore_case` porque el token es
 * `[exploring]` con el estilo por defecto y `🔍 exploring` con el estilo emoji. El orden
 * es el de la lista de fases y es el que Herdr evalúa: gana la primera coincidencia.
 *
 * `roles` es el mapeo rol del tema → fase (S20): el primero que exista y valide manda, y
 * si ninguno lo hace se usa el hex de la paleta de esa misma fase. `toolTitle` cae a
 * `accent` porque es el rol que el tema define para los títulos de herramientas.
 */
const PHASE_COLORS: ReadonlyArray<{
	contains: string;
	roles: readonly ThemeRole[];
	fallback: string;
}> = [
	{ contains: "exploring", roles: ["toolTitle", "accent"], fallback: PALETTE.blue },
	{ contains: "researching", roles: ["toolTitle", "accent"], fallback: PALETTE.blue },
	{ contains: "planning", roles: ["accent"], fallback: PALETTE.mauve },
	{ contains: "deciding", roles: ["accent"], fallback: PALETTE.mauve },
	{ contains: "authorizing", roles: ["accent"], fallback: PALETTE.mauve },
	{ contains: "implementing", roles: ["warning"], fallback: PALETTE.yellow },
	{ contains: "checking", roles: ["success"], fallback: PALETTE.green },
	{ contains: "closing", roles: ["dim"], fallback: PALETTE.overlay },
];

/** Las reglas de fase, con los hex del tema activo que se le pasen o la paleta de siempre. */
export function phaseRules(hexes?: ThemeHexes): StyleRule[] {
	return PHASE_COLORS.map((entry) => ({
		contains: entry.contains,
		ignore_case: true,
		fg: themeHex(hexes, entry.roles, entry.fallback),
	}));
}

/** Las reglas de fase con la paleta fija: el resultado cuando no hay tema activo. */
export const PHASE_RULES: readonly StyleRule[] = phaseRules();

/** Ruta del config de Herdr, resuelta desde el `env` inyectable. */
export function herdrConfigPath(env: Env): string {
	const explicit = env[HERDR_CONFIG_ENV]?.trim();
	if (explicit) return explicit;
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const home = env.HOME?.trim() || homedir();
	return join(xdg || join(home, ".config"), HERDR_CONFIG_DIR, HERDR_CONFIG_FILE);
}

/** Binario de Herdr: `HERDR_BIN_PATH` cuando no está en blanco, `herdr` si no. */
export function herdrBin(env: Env): string {
	return env[HERDR_BIN_ENV]?.trim() || HERDR_BIN;
}

/**
 * Una celda de la fila. Con los colores apagados (el default) es el token pelado, así que
 * la fila es exactamente la que el usuario ya tenía. Con colores: `$name` sigue siendo
 * texto (no se colorea), `$phase` lleva una rule por fase, `$changes` un `fg` neutro
 * (un color por signo no aplica a `+` y `-` a la vez), `$subagent` celeste y `$jobs` gris.
 * Los hex salen del tema activo cuando se los pasa; sin tema, de la paleta de siempre.
 */
function cell(token: string, config: HerdrStatusConfig, hexes?: ThemeHexes): RowCell {
	if (!config.colors) return `$${token}`;
	if (token === PHASE_TOKEN) return { token: `$${token}`, rules: phaseRules(hexes) };
	if (token === CHANGES_TOKEN) return { token: `$${token}`, fg: themeHex(hexes, ["text"], PALETTE.neutral) };
	if (token === TOKEN) return { token: `$${token}`, fg: themeHex(hexes, ["accent"], PALETTE.sky) };
	if (token === JOBS_TOKEN) return { token: `$${token}`, fg: themeHex(hexes, ["muted"], PALETTE.overlay) };
	return `$${token}`;
}

/**
 * Las filas de la fila `pi`: las de por defecto más `$name`/`$phase`/`$changes` juntos y
 * `$subagent` y `$jobs` en filas propias, que desaparecen cuando su token está apagado.
 */
export function sidebarRows(config: HerdrStatusConfig, hexes?: ThemeHexes): SidebarRow[] {
	const nameRow: SidebarRow = [cell(NAME_TOKEN, config), cell(PHASE_TOKEN, config, hexes)];
	if (config.changes) nameRow.push(cell(CHANGES_TOKEN, config, hexes));
	const rows: SidebarRow[] = [["state_icon", "machine", "workspace", "tab"], nameRow];
	if (config.showSubagent) rows.push([cell(TOKEN, config, hexes)]);
	if (config.showJobs) rows.push([cell(JOBS_TOKEN, config, hexes)]);
	return rows;
}

/** Una cadena TOML: los tokens y colores que escribimos son ASCII, JSON los escapa igual. */
function quote(text: string): string {
	return JSON.stringify(text);
}

function ruleToml(rule: StyleRule): string {
	return `{ contains = ${quote(rule.contains)}, ignore_case = ${rule.ignore_case}, fg = ${quote(rule.fg)} }`;
}

function cellToml(cell: RowCell): string {
	if (typeof cell === "string") return quote(cell);
	const parts = [`token = ${quote(cell.token)}`];
	if (cell.fg !== undefined) parts.push(`fg = ${quote(cell.fg)}`);
	if (cell.rules !== undefined) parts.push(`rules = [${cell.rules.map(ruleToml).join(", ")}]`);
	return `{ ${parts.join(", ")} }`;
}

/** El valor TOML de la fila, listo para `pi = …`. */
export function renderRows(rows: readonly SidebarRow[]): string {
	return `[${rows.map((row) => `[${row.map(cellToml).join(", ")}]`).join(", ")}]`;
}

/** El bloque gestionado completo, sin el salto de línea final. */
export function managedBlock(config: HerdrStatusConfig, hexes?: ThemeHexes): string {
	return [
		BEGIN_MARK,
		TABLE_HEADER,
		`${AGENT_ID} = ${renderRows(sidebarRows(config, hexes))}`,
		END_MARK,
	].join("\n");
}

/** Resultado de planear la escritura: el archivo nuevo, o la negativa con su motivo. */
export type PlanResult =
	| { status: "replace"; content: string }
	| { status: "denied"; reason: string };

/** Índices de las líneas cuyo texto recortado es exactamente `value`. */
function lineIndices(lines: readonly string[], value: string): number[] {
	const found: number[] = [];
	lines.forEach((line, index) => {
		if (line.trim() === value) found.push(index);
	});
	return found;
}

/** Una línea es cabecera de tabla TOML cuando es `[...]` o `[[...]]` y no un comentario. */
function isTableHeader(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
	return /^\[\[?[^[\]]+\]\]?$/u.test(trimmed);
}

function denied(reason: string): PlanResult {
	return { status: "denied", reason: `${reason}; nothing was written` };
}

/** Pega el bloque al final, con una línea en blanco de separación. */
function appendBlock(text: string, block: string): string {
	if (text.length === 0) return `${block}\n`;
	const base = text.endsWith("\n") ? text : `${text}\n`;
	const separator = base.endsWith("\n\n") ? "" : "\n";
	return `${base}${separator}${block}\n`;
}

/**
 * Decide el contenido nuevo a partir del actual (puro, sin fs). Un bloque existente se
 * reemplaza; una tabla `rows_by_agent` ajena se rechaza; la fila escrita a mano en T18 se
 * migra sólo con su comentario y su única clave `pi = …`; sin tabla, el bloque se agrega.
 */
export function planSync(text: string, block: string): PlanResult {
	const lines = text.split("\n");
	const begins = lineIndices(lines, BEGIN_MARK);
	const ends = lineIndices(lines, END_MARK);
	if (begins.length > 0 || ends.length > 0) {
		if (begins.length !== 1 || ends.length !== 1) {
			return denied(`the pi-herdr-status block in the Herdr config is incomplete or duplicated`);
		}
		const [begin] = begins;
		const [end] = ends;
		if (end < begin) {
			return denied(`the pi-herdr-status block in the Herdr config is incomplete or duplicated`);
		}
		const next = [...lines.slice(0, begin), ...block.split("\n"), ...lines.slice(end + 1)];
		return { status: "replace", content: next.join("\n") };
	}
	const headers = lineIndices(lines, TABLE_HEADER);
	if (headers.length === 0) return { status: "replace", content: appendBlock(text, block) };
	if (headers.length > 1) return denied(`there are several ${TABLE_HEADER} tables`);
	const header = headers[0];
	const comment = header > 0 ? lines[header - 1].trim() : "";
	if (!comment.startsWith(LEGACY_COMMENT)) {
		return denied(`${TABLE_HEADER} is not managed by pi-herdr-status`);
	}
	// La tabla termina en la próxima cabecera de tabla o al final del archivo.
	let sectionEnd = lines.length;
	for (let index = header + 1; index < lines.length; index += 1) {
		if (isTableHeader(lines[index])) {
			sectionEnd = index;
			break;
		}
	}
	const keys: string[] = [];
	let lastContent = header;
	for (let index = header + 1; index < sectionEnd; index += 1) {
		const trimmed = lines[index].trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		keys.push(trimmed);
		lastContent = index;
	}
	const onlyPiLine = keys.length === 1 && new RegExp(`^${AGENT_ID}\\s*=`, "u").test(keys[0]);
	if (!onlyPiLine) return denied(`${TABLE_HEADER} has keys that pi-herdr-status did not write`);
	const migrated = [
		...lines.slice(0, header - 1),
		...block.split("\n"),
		...lines.slice(lastContent + 1),
	];
	return { status: "replace", content: migrated.join("\n") };
}

/** Sistema de archivos mínimo que la sincronización necesita; inyectable en los tests. */
export type HerdrFs = {
	/** Contenido del archivo, o undefined cuando no existe (el error nunca se crea). */
	readFile(path: string): string | undefined;
	writeFile(path: string, content: string): void;
	copyFile(from: string, to: string): void;
	rename(from: string, to: string): void;
	remove(path: string): void;
	/** Modo (permisos) del archivo, o undefined cuando no existe. */
	mode(path: string): number | undefined;
	/** Aplica un modo a un archivo (chmod), para que el temporal herede los permisos. */
	chmod(path: string, mode: number): void;
	/** true cuando el archivo existe; se usa para no pisar el backup que ya está. */
	exists(path: string): boolean;
};

export const nodeHerdrFs: HerdrFs = {
	readFile(path) {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	writeFile(path, content) {
		writeFileSync(path, content);
	},
	copyFile(from, to) {
		copyFileSync(from, to);
	},
	rename(from, to) {
		renameSync(from, to);
	},
	remove(path) {
		unlinkSync(path);
	},
	mode(path) {
		try {
			return statSync(path).mode & 0o7777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	chmod(path, mode) {
		chmodSync(path, mode);
	},
	exists(path) {
		return existsSync(path);
	},
};

/** Resultado de una invocación de herdr: `ok` es exit code 0, `output` lo que imprimió. */
export type HerdrRunResult = { ok: boolean; output?: string };
/** Ejecuta herdr sin shell; inyectable para que los tests nunca corran el binario real. */
export type HerdrRun = (file: string, args: readonly string[]) => Promise<HerdrRunResult>;

/** Runner por defecto: `execFile` (sin shell), con timeout y la salida de error junta. */
export function herdrRun(timeoutMs = HERDR_TIMEOUT_MS): HerdrRun {
	return (file, args) =>
		new Promise((resolve) => {
			execFile(
				file,
				[...args],
				{ timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
				(error, stdout, stderr) => {
					const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
					resolve({ ok: !error, output });
				},
			);
		});
}

export type SyncStatus = "ok" | "denied" | "error";
/** Lo que el panel informa con `ctx.ui.notify`: sincronizado, negado o error. */
export type SyncResult = { status: SyncStatus; path: string; reason?: string };

export type SyncOptions = {
	config: HerdrStatusConfig;
	env: Env;
	/** Hex del tema activo de Pi; sin ellos la fila usa la paleta fija (S20). */
	theme?: ThemeHexes;
	fs?: HerdrFs;
	run?: HerdrRun;
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Escribe un archivo de trabajo con el modo del original: sin el chmod el temporal sale con
 * el umask del proceso (0666 & ~umask) y el rename le cambia los permisos al config.
 */
function writeWithMode(fs: HerdrFs, path: string, content: string, mode: number | undefined): void {
	fs.writeFile(path, content);
	if (mode !== undefined) fs.chmod(path, mode);
}

/** Borra un temporal que puede no haberse llegado a crear. */
function removeQuietly(fs: HerdrFs, path: string): void {
	try {
		fs.remove(path);
	} catch {
		// El temporal puede no haberse creado: no hay nada que limpiar.
	}
}

/**
 * Escribe la fila en el config de Herdr con backup único y escritura atómica, valida con
 * `herdr config check` (restaurando el original de este sync si falla) y sólo entonces
 * recarga Herdr. Nunca crea el archivo, nunca escribe si la tabla es ajena, nunca pisa una
 * edición hecha mientras corría y nunca tira.
 */
export async function syncHerdrRows(options: SyncOptions): Promise<SyncResult> {
	const path = herdrConfigPath(options.env);
	const fs = options.fs ?? nodeHerdrFs;
	const run = options.run ?? herdrRun();
	let current: string | undefined;
	try {
		current = fs.readFile(path);
	} catch (error) {
		return { status: "error", path, reason: `could not read ${path} (${errorText(error)})` };
	}
	if (current === undefined) {
		return { status: "error", path, reason: `no Herdr config at ${path}; nothing was written` };
	}
	const plan = planSync(current, managedBlock(options.config, options.theme));
	if (plan.status === "denied") return { status: "denied", path, reason: plan.reason };
	const backup = `${path}${BACKUP_SUFFIX}`;
	const temporary = `${path}.${process.pid}.tmp`;
	// R1: el modo del original se lee antes de escribir y se aplica al temporal.
	let mode: number | undefined;
	try {
		mode = fs.mode(path);
	} catch (error) {
		return { status: "error", path, reason: `could not read the permissions of ${path} (${errorText(error)})` };
	}
	try {
		writeWithMode(fs, temporary, plan.content, mode);
		// R3: si alguien editó el config mientras corría el sync, no se escribe nada.
		if (fs.readFile(path) !== current) {
			removeQuietly(fs, temporary);
			return {
				status: "error",
				path,
				reason: `${path} changed during the sync; nothing was written`,
			};
		}
		// R2: el backup guarda la versión previa a la primera intervención y no se pisa nunca.
		if (!fs.exists(backup)) fs.copyFile(path, backup);
		fs.rename(temporary, path);
	} catch (error) {
		removeQuietly(fs, temporary);
		return { status: "error", path, reason: `could not write ${path} (${errorText(error)})` };
	}
	const bin = herdrBin(options.env);
	const check = await run(bin, ["config", "check"]);
	if (!check.ok) {
		const detail = check.output ? `: ${check.output}` : "";
		// R3: sólo se restaura si el archivo sigue siendo exactamente lo que escribió este sync.
		let after: string | undefined;
		try {
			after = fs.readFile(path);
		} catch (error) {
			return {
				status: "error",
				path,
				reason: `herdr config check failed${detail} and ${path} could not be read again, so it was not restored (${errorText(error)})`,
			};
		}
		if (after !== plan.content) {
			return {
				status: "error",
				path,
				reason: `herdr config check failed${detail}; ${path} was edited during the sync, so it was not restored (the original is kept in ${backup})`,
			};
		}
		try {
			// R2: la restauración usa los bytes leídos en este sync, no el backup.
			writeWithMode(fs, temporary, current, mode);
			fs.rename(temporary, path);
		} catch (error) {
			removeQuietly(fs, temporary);
			return {
				status: "error",
				path,
				reason: `herdr config check failed and the previous file could not be restored (${errorText(error)})`,
			};
		}
		return { status: "error", path, reason: `herdr config check failed${detail}; the previous file was restored` };
	}
	const reload = await run(bin, ["server", "reload-config"]);
	if (!reload.ok) {
		const detail = reload.output ? `: ${reload.output}` : "";
		return { status: "error", path, reason: `herdr server reload-config failed${detail}` };
	}
	return { status: "ok", path };
}
