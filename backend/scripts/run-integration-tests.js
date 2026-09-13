import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backend = fileURLToPath(new URL('../', import.meta.url));
const composeFile = path.resolve(backend, '../docker-compose.test.yml');
const project = `travel-integration-${randomUUID().slice(0, 8)}`;
const composeArgs = ['compose', '-f', composeFile, '-p', project];
let provisionStarted = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: backend, stdio: 'inherit', windowsHide: true, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} failed (exit ${result.status})${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return result.stdout?.trim();
}

try {
  // Check availability before creating any resources. Never use the developer DATABASE_URL.
  run('docker', ['info'], { stdio: 'pipe', encoding: 'utf8' });
  provisionStarted = true;
  run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '60']);
  const address = run('docker', [...composeArgs, 'port', 'postgres-test', '5432'], {
    stdio: 'pipe', encoding: 'utf8',
  });
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`Unexpected test address: ${address}`);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://travel_test:travel_test@${address}/travel_assistant_test?schema=public`,
    TRAVEL_INTEGRATION_TEST: 'isolated-postgres',
  };
  run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env });
  run(process.execPath, ['node_modules/prisma/build/index.js', 'generate'], { env });
  run(process.execPath, ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js',
    '--config', 'jest.integration.config.js', '--runInBand'], { env });
} catch (error) {
  console.error(`Integration tests could not complete: ${error.message}`);
  process.exitCode = 1;
} finally {
  // The unique Compose project contains only this run's disposable database.
  if (provisionStarted) {
    const cleanup = spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
      cwd: backend, stdio: 'inherit', windowsHide: true,
    });
    if (cleanup.error || cleanup.status !== 0) process.exitCode = 1;
  }
}
