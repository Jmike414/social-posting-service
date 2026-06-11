'use strict';

const { config } = require('./config');
const { logger } = require('./logger');

// The drafter agent. Takes { brand, brief, intendedPostTime, hasImage } and
// returns platform-formatted copy. Uses the Anthropic API when ANTHROPIC_API_KEY
// is set; otherwise falls back to a deterministic heuristic formatter so the
// whole pipeline still runs (and tests stay offline + stable).

const BRAND_VOICE = {
  propzombie: {
    name: 'PropZombie',
    system:
      'You write short, punchy social posts for PropZombie, a real-estate deal-finding brand for investors and wholesalers. ' +
      'Voice: sharp, confident, value-first, no hype, no emojis-spam. Audience: real-estate investors. ' +
      'Output ONLY the post copy — no preamble, no quotes, no hashtags unless they add real value (max 3).',
    fallbackTags: '#realestate #investing #offmarket',
  },
  crewmando: {
    name: 'CrewMando',
    system:
      'You write short, practical social posts for CrewMando, a brand that connects contractors and crews with work. ' +
      'Voice: blue-collar, direct, respectful, useful. Audience: contractors, tradespeople, crews. ' +
      'Output ONLY the post copy — no preamble, no quotes, no hashtags unless they add real value (max 3).',
    fallbackTags: '#contractors #trades #crews',
  },
};

function voiceFor(brand) {
  return BRAND_VOICE[String(brand || '').toLowerCase()] || BRAND_VOICE.propzombie;
}

// Deterministic, no-network fallback. Cleans the brief into a single post and
// appends light brand hashtags. Intentionally simple and stable.
function heuristicDraft({ brand, brief, hasImage }) {
  const voice = voiceFor(brand);
  const body = String(brief || '').trim().replace(/\s+/g, ' ');
  const cleaned = body.length ? body.charAt(0).toUpperCase() + body.slice(1) : `New update from ${voice.name}.`;
  const imageNote = hasImage ? ' 📷' : '';
  return `${cleaned}${imageNote}\n\n${voice.fallbackTags}`.trim();
}

function buildAnthropicClient() {
  if (!config.anthropic.apiKey) return null;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    return new Anthropic({ apiKey: config.anthropic.apiKey });
  } catch (e) {
    logger.warn(`Anthropic SDK unavailable, using heuristic drafter: ${e.message}`);
    return null;
  }
}

// `client` is injectable for tests. Pass `{ client: null }` to force the heuristic.
function createDrafter({ client } = {}) {
  const anthropic = client !== undefined ? client : buildAnthropicClient();

  async function draft({ brand, brief, intendedPostTime, hasImage } = {}) {
    if (!brief || !String(brief).trim()) {
      throw new Error('drafter requires a non-empty brief');
    }
    if (!anthropic) {
      return heuristicDraft({ brand, brief, hasImage });
    }
    const voice = voiceFor(brand);
    const context = [
      `Brief: ${String(brief).trim()}`,
      hasImage ? 'This post includes an image attachment — write copy that complements an image (do not describe a fake image).' : null,
      intendedPostTime ? `Intended post time: ${intendedPostTime}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const msg = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 400,
        system: voice.system,
        messages: [{ role: 'user', content: context }],
      });
      const text = (msg.content || [])
        .map((b) => (b && b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (!text) throw new Error('empty completion');
      return text;
    } catch (e) {
      logger.warn(`Drafter AI call failed, falling back to heuristic: ${e.message}`);
      return heuristicDraft({ brand, brief, hasImage });
    }
  }

  return { draft };
}

module.exports = { createDrafter, heuristicDraft, voiceFor };
