/**
 * Colored console logger with severity levels.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const COLORS = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	bold: "\x1b[1m",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
	debug: COLORS.dim,
	info: COLORS.green,
	warn: COLORS.yellow,
	error: COLORS.red,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
	debug: "DBG",
	info: "INF",
	warn: "WRN",
	error: "ERR",
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function timestamp(): string {
	return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function formatMessage(level: LogLevel, prefix: string, msg: string, args: unknown[]): string {
	const color = LEVEL_COLORS[level];
	const label = LEVEL_LABELS[level];
	const ts = timestamp();
	const extra = args.length > 0 ? " " + args.map(a => {
		if (a instanceof Error) return a.message;
		if (typeof a === "object") return JSON.stringify(a);
		return String(a);
	}).join(" ") : "";
	return `${COLORS.dim}${ts}${COLORS.reset} ${color}${label}${COLORS.reset} ${COLORS.cyan}[${prefix}]${COLORS.reset} ${msg}${extra}`;
}

export function createLogger(prefix: string) {
	return {
		debug(msg: string, ...args: unknown[]): void {
			if (shouldLog("debug")) console.log(formatMessage("debug", prefix, msg, args));
		},
		info(msg: string, ...args: unknown[]): void {
			if (shouldLog("info")) console.log(formatMessage("info", prefix, msg, args));
		},
		warn(msg: string, ...args: unknown[]): void {
			if (shouldLog("warn")) console.warn(formatMessage("warn", prefix, msg, args));
		},
		error(msg: string, ...args: unknown[]): void {
			if (shouldLog("error")) console.error(formatMessage("error", prefix, msg, args));
		},
	};
}
