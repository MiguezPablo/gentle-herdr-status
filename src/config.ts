/**
 * Configuración persistente del sidebar, en JSON. Sin imports del runtime de Pi: la ruta
 * la resuelve el `env` inyectable, así que este módulo se testea fuera de Pi.
 *
 * Archivo: `$XDG_CONFIG_HOME/pi-herdr-status/config.json`, o `~/.config/pi-herdr-status/config.json`
 * cuando XDG no está definido; `PI_HERDR_STATUS_CONFIG` (una ruta) lo reemplaza por completo,
 * que es lo que usan los tests para no tocar nunca el archivo real del usuario.
 *
 * Un archivo ausente, ilegible, con JSON inválido o con un campo inválido nunca rompe nada:
 * ese campo cae en su default y los demás se conservan. Las variables de entorno existentes
 * mandan sobre el archivo, porque son las que ya se podían usar antes de tener config.
 *
 * Este módulo también tiene la lógica del `/herdr-status` (filas del panel, ciclado de
 * valores, renombrado y línea de resumen); el panel de la TUI es sólo una capa delgada
 * encima de estas funciones puras.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CHANGES_ENV, changesEnabled } from "./changes.ts";
import { PANEL_NAME, type Env } from "./herdr.ts";
import { STYLE_ENV, styleFromEnv, type Style } from "./phase.ts";
import { sanitizeName } from "./tracker.ts";

/** Ruta del archivo de config: reemplaza a la de XDG/HOME cuando está definida. */
export const CONFIG_ENV = "PI_HERDR_STATUS_CONFIG";
/** Directorio dentro de XDG_CONFIG_HOME (o ~/.config). */
export const CONFIG_DIR = "pi-herdr-status";
/** Nombre del archivo de config dentro de ese directorio. */
export const CONFIG_FILE = "config.json";

/** Las seis opciones, en el orden en que el panel las muestra. */
export const OPTION_IDS = [
	"style",
	"changes",
	"showSubagent",
	"showJobs",
	"colors",
	"name",
] as const;

export type OptionId = (typeof OPTION_IDS)[number];

/** Configuración del sidebar tal como se guarda en el archivo. */
export interface HerdrStatusConfig {
	/** Un solo estilo para fase, subagente y jobs: nunca por secciones. */
	style: Style;
	changes: boolean;
	name: string;
	showSubagent: boolean;
	showJobs: boolean;
	/** Celdas con estilo y colores en la fila gestionada del config de Herdr (S16). */
	colors: boolean;
}

/**
 * Defaults: exactamente lo que hacía la extensión antes de existir el archivo, para que sin
 * config y sin variables el sidebar se vea igual que siempre.
 */
export const DEFAULT_CONFIG: HerdrStatusConfig = {
	style: "plain",
	changes: false,
	name: PANEL_NAME,
	showSubagent: true,
	showJobs: true,
	colors: false,
};

/** Opciones que una variable de entorno puede fijar; el resto sólo las edita el panel. */
export const FORCED_BY: Partial<Record<OptionId, string>> = {
	style: STYLE_ENV,
	changes: CHANGES_ENV,
};

/** Opciones que el panel no puede cambiar porque una variable las fija. */
export type ForcedOptions = ReadonlySet<OptionId>;

/** Config en efecto: lo del archivo con la precedencia de las variables ya aplicada. */
export interface EffectiveConfig {
	config: HerdrStatusConfig;
	forced: ForcedOptions;
}

/** Etiqueta de cada opción en el panel. */
const OPTION_LABELS: Record<OptionId, string> = {
	style: "Style",
	changes: "Changes token",
	showSubagent: "Subagent token",
	showJobs: "Jobs token",
	colors: "Sidebar colors",
	name: "Panel name",
};

/** Una fila del panel: la opción, su valor visible y la variable que la fija, si hay una. */
export interface OptionRow {
	id: OptionId;
	label: string;
	value: string;
	forcedBy?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un `style` válido, o undefined. */
function readStyle(value: unknown): Style | undefined {
	return value === "plain" || value === "emoji" ? value : undefined;
}

/**
 * El estilo de un archivo, con migración: un `style` válido manda; si no hay (o no es válido,
 * que se lee como ausente) y el archivo viejo traía `phaseStyle` o `subagentStyle` en "emoji",
 * el estilo es emoji; en cualquier otro caso, plain.
 */
function readStyleWithMigration(source: Record<string, unknown>): Style {
	const style = readStyle(source.style);
	if (style !== undefined) return style;
	const legacy = source.phaseStyle === "emoji" || source.subagentStyle === "emoji";
	return legacy ? "emoji" : DEFAULT_CONFIG.style;
}

/** Un nombre usable: una línea sagitada y con tope; vacío cae al default. */
function readName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeName(value) || undefined;
}

/**
 * Convierte JSON arbitrario en una config usable, campo por campo: el campo válido se
 * conserva y el inválido o ausente cae en su propio default. Al normalizar se descartan los
 * campos viejos (`phaseStyle`, `subagentStyle`), así que guardar escribe sólo `style`.
 */
export function normalizeConfig(raw: unknown): HerdrStatusConfig {
	const source = record(raw) ? raw : {};
	return {
		style: readStyleWithMigration(source),
		changes: typeof source.changes === "boolean" ? source.changes : DEFAULT_CONFIG.changes,
		name: readName(source.name) ?? DEFAULT_CONFIG.name,
		showSubagent: typeof source.showSubagent === "boolean" ? source.showSubagent : DEFAULT_CONFIG.showSubagent,
		showJobs: typeof source.showJobs === "boolean" ? source.showJobs : DEFAULT_CONFIG.showJobs,
		colors: typeof source.colors === "boolean" ? source.colors : DEFAULT_CONFIG.colors,
	};
}

/** Ruta del archivo de config, resuelta desde el `env` inyectable. */
export function configFilePath(env: Env): string {
	const explicit = env[CONFIG_ENV]?.trim();
	if (explicit) return explicit;
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const home = env.HOME?.trim() || homedir();
	return join(xdg || join(home, ".config"), CONFIG_DIR, CONFIG_FILE);
}

/** Lee la config; nunca tira: un archivo ausente o inválido da los defaults. */
export function loadConfig(path: string): HerdrStatusConfig {
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Escribe la config normalizada con dos espacios: crea el directorio, escribe un temporal
 * al lado y lo renombra encima del archivo, así que un lector nunca ve un JSON a medias.
 * Propaga el error para que el comando lo informe.
 */
export function saveConfig(path: string, config: HerdrStatusConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// El temporal puede no haberse llegado a crear: no hay nada que limpiar.
		}
		throw error;
	}
}

/**
 * Aplica la precedencia del env sobre lo guardado: una variable definida (aunque sea
 * vacía) fija su opción y el panel deja de poder editarla; sin la variable manda el archivo.
 */
export function effectiveConfig(config: HerdrStatusConfig, env: Env): EffectiveConfig {
	const normalized = normalizeConfig(config);
	const forced = forcedOptions(env);
	return {
		config: {
			...normalized,
			style: forced.has("style") ? styleFromEnv(env) : normalized.style,
			changes: forced.has("changes") ? changesEnabled(env) : normalized.changes,
		},
		forced,
	};
}

/** Las opciones que el `env` define; cada una fija su valor y sale del alcance del panel. */
export function forcedOptions(env: Env): ForcedOptions {
	const forced = new Set<OptionId>();
	for (const id of OPTION_IDS) {
		const variable = FORCED_BY[id];
		if (variable !== undefined && env[variable] !== undefined) forced.add(id);
	}
	return forced;
}

/** Valor visible de una opción. */
export function optionValue(id: OptionId, config: HerdrStatusConfig): string {
	if (id === "name") return config.name;
	if (id === "style") return config.style;
	return config[id] ? "on" : "off";
}

/** Filas del panel para la config y las opciones forjadas por el env. */
export function optionRows(config: HerdrStatusConfig, forced: ForcedOptions = new Set()): OptionRow[] {
	return OPTION_IDS.map((id) => {
		const variable = forced.has(id) ? FORCED_BY[id] : undefined;
		const row: OptionRow = { id, label: OPTION_LABELS[id], value: optionValue(id, config) };
		if (variable !== undefined) row.forcedBy = variable;
		return row;
	});
}

/**
 * La config que resulta de pasar una opción a su otro valor (toggle o ciclo). `name` es
 * texto, así que no cicla y la config vuelve igual.
 */
export function cycleOption(config: HerdrStatusConfig, id: OptionId): HerdrStatusConfig {
	const normalized = normalizeConfig(config);
	if (id === "style") return { ...normalized, style: normalized.style === "emoji" ? "plain" : "emoji" };
	if (id === "name") return normalized;
	return { ...normalized, [id]: !normalized[id] };
}

/** La config con el nombre nuevo, normalizado igual que el que viene del archivo. */
export function applyName(config: HerdrStatusConfig, name: string): HerdrStatusConfig {
	return { ...normalizeConfig(config), name: sanitizeName(name) || DEFAULT_CONFIG.name };
}

/** Una línea con la config en efecto, para el aviso cuando no hay TUI. */
export function describeConfig(config: HerdrStatusConfig): string {
	return [
		`style ${config.style}`,
		`changes ${config.changes ? "on" : "off"}`,
		`$subagent ${config.showSubagent ? "on" : "off"}`,
		`$jobs ${config.showJobs ? "on" : "off"}`,
		`colors ${config.colors ? "on" : "off"}`,
		`name ${config.name}`,
	].join(", ");
}
