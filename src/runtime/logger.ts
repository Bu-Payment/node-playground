export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type LogWriter = (line: string) => void;

export function createLogger(write: LogWriter = defaultWriter): Logger {
  return {
    info: (message, fields) => write(format("info", message, fields)),
    error: (message, fields) => write(format("error", message, fields)),
  };
}

function format(level: string, message: string, fields?: LogFields): string {
  return JSON.stringify({ level, message, ...(fields ?? {}) });
}

function defaultWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}
