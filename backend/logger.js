const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[configured] ?? LEVELS.info;
}

function log(level, msg, context = {}) {
  if (LEVELS[level] < currentLevel()) return;
  const line = { ts: new Date().toISOString(), level, msg, ...context };
  const write = level === 'error' || level === 'warn' ? console.error : console.log;
  write(JSON.stringify(line));
}

export const logger = {
  debug: (msg, context) => log('debug', msg, context),
  info: (msg, context) => log('info', msg, context),
  warn: (msg, context) => log('warn', msg, context),
  error: (msg, context) => log('error', msg, context),
};
