'use strict';

// Live GraphQL introspection — proves the adapter is built against the real beta
// schema, not guesses. Run with BUFFER_API_KEY set:
//
//   node scripts/introspect.js
//
// Writes the full introspection JSON to schema-introspection.json and prints the
// key input types this service depends on (CreatePostInput, AssetInput,
// ImageAssetInput, ImageMetadataInput, ChannelsInput, PostsInput).

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const bufferClient = require('../src/publisher/buffer-client');

const KEY_TYPES = ['CreatePostInput', 'AssetInput', 'ImageAssetInput', 'ImageMetadataInput', 'ChannelsInput', 'PostsInput', 'PostsFiltersInput', 'ShareMode', 'SchedulingType'];

function typeName(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`;
  return t.name || '?';
}

async function main() {
  if (!config.buffer.apiKey) {
    console.error('BUFFER_API_KEY is not set. Set it and re-run to introspect the live schema.');
    process.exit(1);
  }
  console.log('Introspecting', config.buffer.apiUrl, '...\n');
  const schema = await bufferClient.introspect();
  const outPath = path.join(__dirname, '..', 'schema-introspection.json');
  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2));

  const byName = new Map((schema.types || []).map((t) => [t.name, t]));
  for (const name of KEY_TYPES) {
    const t = byName.get(name);
    if (!t) { console.log(`(missing) ${name}`); continue; }
    if (t.enumValues && t.enumValues.length) {
      console.log(`enum ${name} = ${t.enumValues.map((v) => v.name).join(' | ')}`);
    } else {
      console.log(`input ${name} {`);
      for (const f of t.inputFields || []) console.log(`  ${f.name}: ${typeName(f.type)}`);
      console.log('}');
    }
    console.log('');
  }
  console.log(`Full schema written to ${outPath}`);
}

main().catch((e) => {
  console.error('Introspection failed:', e.message);
  if (e.raw) console.error('Raw:', JSON.stringify(e.raw));
  process.exit(1);
});
