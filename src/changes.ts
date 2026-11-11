/**
 * Contador de líneas sin commitear, opt-in: con `PI_HERDR_STATUS_CHANGES=1` el sidebar
 * muestra `+<agregadas> -<borradas>` al lado del nombre del panel; sin la variable, o con
 * cualquier otro valor, el token nunca se calcula y queda limpio.
 *
 * Qué cuenta (siempre contra `HEAD`, o sea staged + unstaged):
 * - `git diff --numstat HEAD`: las filas binarias (`-\t-`) se saltan.
 * - `git ls-files --others --exclude-standard`: los untracked no ignorados suman sus
 *   líneas; un archivo con un byte NUL se trata como binario y no suma nada.
 * - Un repo sin commits compara contra el árbol vacío de git.
 *
 * Cuándo se recalcula: sólo cuando la extensión recibe un evento de Pi
 * (`session_start`, `agent_start`, cada `tool_result`, el evento de jobs y `agent_end`),
 * nunca con un timer propio. La medición es asíncrona (`execFile`, sin shell) para no
 * bloquear el loop de eventos: a lo sumo una en vuelo y, si llegan eventos mientras
 * corre, exactamente un recálculo más al terminar. Un error, un timeout o no estar en un
 * repo git dan `null`, nunca el valor anterior: el token no puede quedar viejo (S4).
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Env } from "./herdr.ts";

/** Opt-in: sólo el valor exacto `1` enciende el token. */
export const CHANGES_ENV = "PI_HERDR_STATUS_CHANGES";
/** El único valor que enciende el contador. */
export const CHANGES_ON = "1";
/** Hash del árbol vacío de git: base para comparar cuando el repo todavía no tiene commits. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Tope de cada comando de git; pasado ese tiempo el token queda limpio. */
export const GIT_TIMEOUT_MS = 2_000;

/** Ejecuta git sin shell y devuelve su stdout; rechaza en error o timeout. */
export type GitRun = (args: readonly string[], cwd: string) => Promise<string>;
/** Lectura de un archivo del repo; inyectable para los tests. */
export type ReadFile = (path: string) => Promise<Buffer>;
export type ChangesOptions = {
	cwd: string;
	run?: GitRun;
	readFile?: ReadFile;
	timeoutMs?: number;
	/** Se llama con el valor nuevo cada vez que termina una medición (nunca tras `dispose`). */
	onChange: (token: string | null) => void;
};

/** `env` pide el contador: sólo el valor exacto `1`, sin trim. */
export function changesEnabled(env: Env): boolean {
	return env[CHANGES_ENV] === CHANGES_ON;
}

/** Runner por defecto: `execFile` (sin shell), con timeout y un buffer holgado. */
export function gitRun(timeoutMs = GIT_TIMEOUT_MS): GitRun {
	return (args, cwd) =>
		new Promise((resolve, reject) => {
			execFile(
				"git",
				[...args],
				{ cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				},
			);
		});
}

/** Formato del token: `+120 -40` (guion ASCII); sin cambios no hay token. */
export function changesToken(added: number, deleted: number): string | null {
	if (added === 0 && deleted === 0) return null;
	return `+${added} -${deleted}`;
}

/** Líneas de un archivo de texto; `undefined` cuando es binario (tiene un byte NUL). */
function countLines(content: Buffer): number | undefined {
	if (content.includes(0)) return undefined;
	if (content.length === 0) return 0;
	const lines = content.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.length;
}

/**
 * Mide en serie, una vez por disparador, y publica el resultado por `onChange`.
 * `reset()` olvida el valor (session_start) y `dispose()` corta todo (shutdown).
 */
export class ChangesCounter {
	private readonly run: GitRun;
	private readonly read: ReadFile;
	private readonly timeoutMs: number;
	private readonly onChange: (token: string | null) => void;
	private cwd: string;
	private value: string | null = null;
	private inFlight = false;
	private queued = false;
	private disposed = false;

	constructor(options: ChangesOptions) {
		this.cwd = options.cwd;
		this.run = options.run ?? gitRun(options.timeoutMs ?? GIT_TIMEOUT_MS);
		this.read = options.readFile ?? ((path) => readFile(path));
		this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
		this.onChange = options.onChange;
	}

	/** Último valor medido; `null` mientras no haya medición o si falló. */
	token(): string | null {
		return this.value;
	}

	/** Pide una medición; con una en vuelo deja sólo un recálculo pendiente. */
	refresh(cwd?: string): void {
		if (this.disposed) return;
		if (cwd !== undefined && cwd.length > 0) this.cwd = cwd;
		if (this.inFlight) {
			this.queued = true;
			return;
		}
		void this.measure();
	}

	/** Olvida el valor sin cancelar una medición en vuelo (session_start). */
	reset(): void {
		this.value = null;
		this.queued = false;
	}

	/** Shutdown: no mide más y descarta lo que estuviera en vuelo. */
	dispose(): void {
		this.disposed = true;
		this.queued = false;
		this.value = null;
	}

	private async measure(): Promise<void> {
		this.inFlight = true;
		let token: string | null = null;
		try {
			token = await this.guarded();
		} catch {
			token = null;
		}
		this.inFlight = false;
		if (this.disposed) return;
		this.value = token;
		this.onChange(token);
		if (this.queued) {
			this.queued = false;
			void this.measure();
		}
	}

	/** La medición con tope de tiempo propio, para que un git colgado no deje el token sin fin. */
	private async guarded(): Promise<string | null> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("git timeout")), this.timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([this.count(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async count(): Promise<string | null> {
		const base = await this.base();
		let added = 0;
		let deleted = 0;
		for (const row of (await this.run(["diff", "--numstat", base], this.cwd)).split("\n")) {
			const [plus, minus] = row.split("\t");
			const up = Number.parseInt(plus ?? "", 10);
			const down = Number.parseInt(minus ?? "", 10);
			// Las filas binarias de numstat vienen como `-\t-` y no son números.
			if (!Number.isFinite(up) || !Number.isFinite(down)) continue;
			added += up;
			deleted += down;
		}
		for (const file of (await this.run(["ls-files", "--others", "--exclude-standard"], this.cwd)).split("\n")) {
			const path = file.trim();
			if (path.length === 0) continue;
			const lines = countLines(await this.read(join(this.cwd, path)));
			if (lines !== undefined) added += lines;
		}
		return changesToken(added, deleted);
	}

	/** HEAD del repo; sin commits se compara contra el árbol vacío. */
	private async base(): Promise<string> {
		try {
			const head = (await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], this.cwd)).trim();
			return head.length > 0 ? head : EMPTY_TREE;
		} catch {
			return EMPTY_TREE;
		}
	}
}
