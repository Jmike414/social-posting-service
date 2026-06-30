'use strict';

// Central env loading. Mirrors the simple, point-of-use pattern: load dotenv
// once here, expose a frozen config object. Secrets are read from env only and
// never logged (see redaction in logger.js).
require('dotenv').config();

const path = require('path');

// The brands this service can publish for. Brand-agnostic from day one:
// adding a brand here + populating its channel map (setup-channels) is the only
// change needed. Only PropZombie channels exist today.
const BRANDS = ['propzombie', 'crewmando'];

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const config = {
  port: Number(process.env.PORT || 4000),
  // Buffer fetches uploaded images by URL, so this must be the public host. On
  // Render, RENDER_EXTERNAL_URL is injected automatically — fall back to it so
  // image posts work without manual config.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, ''),

  consolePassword: process.env.CONSOLE_PASSWORD || '',
  consolePasswordEs: process.env.CONSOLE_PASSWORD_ES || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  serviceToken: process.env.SERVICE_TOKEN || '',

  buffer: {
    apiKey: process.env.BUFFER_API_KEY || '',
    apiUrl: (process.env.BUFFER_API_URL || 'https://api.buffer.com').replace(/\/+$/, ''),
    organizationId: process.env.BUFFER_ORGANIZATION_ID || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },

  datastore: {
    // Postgres deploy target takes precedence if provided; otherwise SQLite file.
    databaseUrl: process.env.DATABASE_URL || '',
    sqlitePath: process.env.SQLITE_PATH
      ? path.resolve(process.env.SQLITE_PATH)
      : path.join(__dirname, '..', 'data', 'social.db'),
  },

  heygen: {
    apiKey: process.env.HEYGEN_API_KEY || '',
    avatarId: process.env.HEYGEN_AVATAR_ID || '',
    voiceIdEn: process.env.HEYGEN_VOICE_ID_EN || '',
    voiceIdEs: process.env.HEYGEN_VOICE_ID_ES || '',
  },

  brands: BRANDS,
};

function isBrand(b) {
  return BRANDS.includes(String(b || '').toLowerCase());
}

// Surfaces missing-but-required config without throwing, so the service can boot
// in degraded/dev mode and the console can show a clear warning. Mirrors the
// engine's "stay up and warn" launch posture.
function validate() {
  const fatal = [];
  const warnings = [];
  if (!config.consolePassword) fatal.push('CONSOLE_PASSWORD is required (operator console login).');
  if (config.sessionSecret === 'dev-only-insecure-secret-change-me') {
    warnings.push('SESSION_SECRET is the insecure default — set a random value in production.');
  }
  if (!config.buffer.apiKey) warnings.push('BUFFER_API_KEY not set — posting to Buffer is disabled until provided.');
  if (!config.anthropic.apiKey) warnings.push('ANTHROPIC_API_KEY not set — drafter falls back to the heuristic formatter.');
  if (!config.heygen.apiKey) warnings.push('HEYGEN_API_KEY not set — HeyGen video generation is disabled until provided.');
  return { fatal, warnings };
}

module.exports = { config, isBrand, bool, validate, BRANDS };
