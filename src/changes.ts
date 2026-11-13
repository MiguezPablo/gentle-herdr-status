/**
 * Contador de líneas sin commitear, opt-in: con `PI_HERDR_STATUS_CHANGES=1` el sidebar
 * muestra `+<agregadas> -<borradas>` al lado del nombre del panel; sin la variable, o con
 * cualquier otro valor, el token nunca se calcula y queda limpio.
 *
 * Qué cuenta, con la misma regla que el contador "Changes" de Gentle Shell:
 * - `git diff --numstat HEAD`: las filas binarias (`-\t-`) se saltan.
 * - `git status --porcelain=v1 --untracked-files=all -z`: los untracked no ignorados
 *   (`??`) suman sus líneas, contadas en Node (`lstat` + lectura utf8): un symlink, un
 *   directorio, un archivo de más de 1 MiB o un archivo vacío suman 0; el resto suma
 *   `split("\n")`, sin la línea final vacía cuando el archivo termina en salto de línea.
 * - Un repo sin commits (`HEAD` nonato) no muestra token: no hay contra qué comparar.
 *
 * Cuándo se recalcula: sólo cuando la extensión recibe un evento de Pi
 * (`session_start`, `agent_start`, cada `tool_result`, el evento de jobs y `agent_end`),
 * nunca con un timer propio. La medición es asíncrona (`execFile`, sin shell) para no
 * bloquear el loop de eventos: a lo sumo una en vuelo y, si llegan eventos mientras
 * corre, exactamente un recálculo más al terminar. Un error, un timeout o no estar en un
 * repo git dan `null`, nunca el valor anterior: el token no puede quedar viejo (S4).
 */
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Env } from "./herdr.ts";

/** Opt-in: sólo el valor exacto `1` enciende el token. */
export const CHANGES_ENV = "PI_HERDR_STATUS_CHANGES";
/** El único valor que enciende el contador. */
export const CHANGES_ON = "1";
/** Tope de cada comando de git; pasado ese tiempo el token queda limpio. */
export const GIT_TIMEOUT_MS = 2_000;
/** Tope de tamaño de un untracked: 1 MiB, igual que Gentle Shell. */
export const UNTRACKED_MAX_BYTES = 1024 * 1024;

/** Ejecuta git sin shell y devuelve su stdout; rechaza en error o timeout. */
export type GitRun = (args: readonly string[], cwd: string) => Promise<string>;
/** Líneas de un untracked; inyectable para los tests. */
export type CountLines = (path: string) => Promise<number>;
export type ChangesOptions = {
	cwd: string;
	run?: GitRun;
	countLines?: CountLines;
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

/**
 * Líneas de un archivo untracked, con la regla de Gentle Shell: sólo un archivo regular de
 * hasta 1 MiB cuenta (un symlink, un directorio o algo más grande suma 0), un archivo
 * vacío suma 0 y el resto suma sus `\n`, sin contar el vacío detrás del último.
 */
export async function untrackedLines(path: string): Promise<number> {
	const stats = await lstat(path).catch(() => undefined);
	if (stats === undefined || !stats.isFile() || stats.size > UNTRACKED_MAX_BYTES) return 0;
	const text = await readFile(path, "utf8");
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Mide en serie, una vez por disparador, y publica el resultado por `onChange`.
 * `reset()` olvida el valor (session_start) y `dispose()` corta todo (shutdown).
 */
export class ChangesCounter {
	private readonly run: GitRun;
	private readonly countLines: CountLines;
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
		this.countLines = options.countLines ?? untrackedLines;
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
		const head = await this.head();
		// Sin commits no hay contra qué comparar: Gentle Shell no muestra cambios ahí.
		if (head === null) return null;
		let added = 0;
		let deleted = 0;
		for (const row of (await this.run(["diff", "--numstat", head], this.cwd)).split("\n")) {
			const [plus, minus] = row.split("\t");
			const up = Number.parseInt(plus ?? "", 10);
			const down = Number.parseInt(minus ?? "", 10);
			// Las filas binarias de numstat vienen como `-\t-` y no son números.
			if (!Number.isFinite(up) || !Number.isFinite(down)) continue;
			added += up;
			deleted += down;
		}
		// `-z` separa por NUL y no escapa rutas: cada untracked (`??`) suma sus líneas.
		const status = await this.run(["status", "--porcelain=v1", "--untracked-files=all", "-z"], this.cwd);
		for (const record of status.split("\0")) {
			if (!record.startsWith("?? ")) continue;
			added += await this.countLines(join(this.cwd, record.slice(3)));
		}
		return changesToken(added, deleted);
	}

	/** `HEAD` del repo; `null` cuando el repo todavía no tiene commits. */
	private async head(): Promise<string | null> {
		try {
			const head = (await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], this.cwd)).trim();
			return head.length > 0 ? head : null;
		} catch {
			return null;
		}
	}
}
