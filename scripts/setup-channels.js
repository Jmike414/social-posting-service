'use strict';

// Setup script — run ONCE (or whenever channels change) with BUFFER_API_KEY set.
// Queries the live Buffer account for connected channels and persists the
// brand -> channel-ID map into the datastore. Channel IDs are NEVER hardcoded.
//
//   node scripts/setup-channels.js [brand] [--channels id1,id2]
//
//   brand        defaults to "propzombie". All discovered channels are mapped to
//                this brand unless --channels limits the set.
//   --channels   comma-separated Buffer channel IDs to include (subset).
//
// Re-run with a different brand later (e.g. crewmando) to map its channels with
// zero code changes.

const { config, isBrand } = require('../src/config');
const { createStore } = require('../src/db');
const bufferClient = require('../src/publisher/buffer-client');

async function main() {
  const args = process.argv.slice(2);
  const brand = (args.find((a) => !a.startsWith('--')) || 'propzombie').toLowerCase();
  const chArg = args.find((a) => a.startsWith('--channels='));
  const onlyIds = chArg ? chArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null;

  if (!isBrand(brand)) {
    console.error(`Unknown brand "${brand}". Expected: ${config.brands.join(', ')}`);
    process.exit(1);
  }
  if (!config.buffer.apiKey) {
    console.error('BUFFER_API_KEY is not set. Set it in .env (or the environment) and re-run.');
    process.exit(1);
  }

  console.log('Resolving organization...');
  const orgs = await bufferClient.getOrganizations();
  if (!orgs.length) {
    console.error('No organizations on this Buffer account.');
    process.exit(1);
  }
  orgs.forEach((o) => console.log(`  org: ${o.id}  ${o.name || ''}`));
  const orgId = config.buffer.organizationId || orgs[0].id;
  console.log(`Using organization: ${orgId}\n`);

  console.log('Fetching connected channels...');
  let channels = await bufferClient.getChannels(orgId);
  channels.forEach((c) =>
    console.log(`  channel: ${c.id}  [${c.service}/${c.type}]  ${c.displayName || c.name}${c.isDisconnected ? '  (DISCONNECTED)' : ''}`)
  );

  if (onlyIds) channels = channels.filter((c) => onlyIds.includes(c.id));
  channels = channels.filter((c) => !c.isDisconnected);

  if (!channels.length) {
    console.error('\nNo (connected) channels to map. Aborting.');
    process.exit(1);
  }

  // Uses the same store selection as the service: Postgres if DATABASE_URL is set,
  // else SQLite. Re-running is idempotent (setChannels replaces the brand's set).
  const store = await createStore();
  await store.kvSet('organization_id', orgId);
  const saved = await store.setChannels(brand, channels);
  await store.close();

  console.log(`\n✓ Mapped ${saved.length} channel(s) to brand "${brand}":`);
  saved.forEach((c) => console.log(`  ${brand} -> ${c.id}  [${c.service}]  ${c.displayName || c.name}`));
  console.log('\nDone. These IDs are now persisted in the datastore (not in source).');
}

main().catch((e) => {
  console.error('Setup failed:', e.message);
  if (e.raw) console.error('Raw:', JSON.stringify(e.raw));
  process.exit(1);
});
