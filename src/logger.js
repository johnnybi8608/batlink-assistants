// Minimal structured JSON logger (no pino dependency): logger.info(obj, msg) / logger.info(msg),
// child() adds bound context fields.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', bindings = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (objOrMsg, maybeMsg) => {
    if (LEVELS[lvl] < min) return;
    const [obj, msg] = typeof objOrMsg === 'string' ? [{}, objOrMsg] : [objOrMsg ?? {}, maybeMsg ?? ''];
    const line = { t: new Date().toISOString(), lvl, msg, ...bindings, ...obj };
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => createLogger(level, { ...bindings, ...extra })
  };
}
