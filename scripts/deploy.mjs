import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrangler = fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json')));
const args = process.argv.slice(2);

function runWrangler(command) {
  const result = spawnSync(process.execPath, [wrangler, ...command], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The deploy-button wizard already built the assets and provisioned the DB binding.
if (process.env.WORKERS_CI === '1' && args.length === 0) {
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
} else {
  // Local and custom deployments retain their own migration target and Wrangler flags.
  const { build } = await import('vite');
  await build();
}
runWrangler(['deploy', ...args]);
