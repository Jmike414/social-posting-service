'use strict';

// Tiny logger with secret redaction. The Buffer API key and console password
// must never appear in logs. We scrub anything that looks like the configured
// secrets, plus common token patterns, from every logged string.
const { config } = require('./config');

function secretsList() {
  return [config.buffer.apiKey, config.anthropic.apiKey, config.serviceToken, config.consolePassword, config.consolePasswordEs]
    .filter((s) => s && String(s).length >= 6);
}

function redact(input) {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const secret of secretsList()) {
    if (s.includes(secret)) s = s.split(secret).join('«redacted»');
  }
  // Generic bearer-token scrub as a backstop.
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1«redacted»');
  return s;
}

function safeStringify(obj) {
  try {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function fmt(args) {
  return args.map((a) => redact(typeof a === 'string' ? a : safeStringify(a))).join(' ');
}

const logger = {
  info: (...a) => console.log('[social]', fmt(a)),
  warn: (...a) => console.warn('[social][warn]', fmt(a)),
  error: (...a) => console.error('[social][error]', fmt(a)),
  redact,
};

module.exports = { logger, redact };
