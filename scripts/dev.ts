/**
 * One command for the whole local demo:
 *
 *   npm run dev            # anvil + deploy + 6 services + app (5173) + exit app (5174)
 *   npm run dev -- --fresh # restart from a fresh chain state even if one is running
 *   npm run dev -- --no-app
 *
 * Requires Foundry (anvil, forge) on the PATH.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const RPC = 'http://127.0.0.1:8545';
const children: ChildProcess[] = [];

const color = (c: number, s: string) => `\x1b[${c}m${s}\x1b[0m`;

function run(name: string, c: number, cmd: string, cmdArgs: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, FORCE_COLOR: '1', ...opts.env },
    shell: process.platform === 'win32',
  });
  const prefix = color(c, `[${name}]`.padEnd(16));
  const pipe = (data: Buffer) =>
    data
      .toString()
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => console.log(`${prefix} ${l}`));
  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);
  child.on('exit', (code) => console.log(`${prefix} exited (${code})`));
  children.push(child);
  return child;
}

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function deploymentAlive(): Promise<boolean> {
  const p = join(ROOT, 'deployments', 'local.json');
  if (!existsSync(p)) return false;
  const factory = JSON.parse(readFileSync(p, 'utf8')).contracts.factory;
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [factory, 'latest'] }),
  });
  const { result } = (await r.json()) as { result: string };
  return !!result && result !== '0x';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const networkArg = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'local';

async function main() {
  const fresh = args.includes('--fresh');
  if (networkArg === 'base-sepolia') return startRemote();

  // 1. Chain
  if (!(await rpcUp())) {
    console.log(color(36, '▶ starting anvil (chain 31337, Osaka hardfork: P-256 precompile)'));
    run('anvil', 90, 'anvil', ['--chain-id', '31337', '--port', '8545', '--hardfork', 'osaka', '--silent']);
    for (let i = 0; i < 50 && !(await rpcUp()); i++) await sleep(200);
    if (!(await rpcUp())) throw new Error('anvil did not start — is Foundry installed? (https://getfoundry.sh)');
  } else {
    console.log(color(36, '▶ using the chain already running on 8545'));
  }

  // 2. Contracts
  if (!existsSync(join(ROOT, 'contracts', 'out', 'RutliAccount.sol', 'RutliAccount.json'))) {
    console.log(color(36, '▶ forge build'));
    const r = spawnSync('forge', ['build'], { cwd: join(ROOT, 'contracts'), stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error('forge build failed');
  }

  // 3. Deploy (only when the chain does not already have our contracts)
  if (fresh || !(await deploymentAlive())) {
    console.log(color(36, '▶ deploying contracts and bootstrapping the institutions'));
    const r = spawnSync('npx', ['tsx', 'scripts/setup.ts', '--network', 'local'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error('setup failed');
  } else {
    console.log(color(36, '▶ contracts already deployed on this chain (use --fresh to redeploy)'));
  }

  // 4. Services — each one a separate process with its own storage.
  const services: Array<[string, number]> = [
    ['sq-core', 34],
    ['sq-cosigner', 35],
    ['poste-guardian', 33],
    ['video-ident', 36],
    ['gas-station', 32],
    ['watchtower', 90],
  ];
  for (const [name, c] of services) {
    run(name, c, 'npx', ['tsx', `src/${name}/index.ts`], { cwd: join(ROOT, 'services') });
  }

  // 5. Apps
  if (!args.includes('--no-app')) {
    await sleep(1500);
    run('app', 97, 'npx', ['vite', '--port', '5173', '--strictPort'], { cwd: join(ROOT, 'app') });
    run('exit-app', 31, 'npx', ['vite', '--port', '5174', '--strictPort'], { cwd: join(ROOT, 'exit-app') });
    await sleep(2500);
    console.log(
      color(
        32,
        `\n✔ Rütli is running\n` +
          `   App (Claire's phone)      http://localhost:5173\n` +
          `   App (Claire's new phone)  http://localhost:5173/?device=new-phone\n` +
          `   La Poste mailbox          http://localhost:5173/#/mailbox\n` +
          `   Back-office / agents      http://localhost:5173/#/ops\n` +
          `   Exit app (no Swissquote)  http://localhost:5174\n`,
      ),
    );
  }
}

/** Base Sepolia: contracts already deployed with "npm run setup:base-sepolia"; start services and apps only. */
async function startRemote() {
  const p = join(ROOT, 'deployments', 'base-sepolia.json');
  if (!existsSync(p)) throw new Error('Run "npm run setup:base-sepolia" first (needs DEPLOYER_PRIVATE_KEY).');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  const env = { RUTLI_NETWORK: 'base-sepolia' };
  const services: Array<[string, number]> = [
    ['sq-core', 34],
    ['sq-cosigner', 35],
    ['poste-guardian', 33],
    ['video-ident', 36],
    ['gas-station', 32],
    ['watchtower', 90],
  ];
  for (const [name, c] of services) run(name, c, 'npx', ['tsx', `src/${name}/index.ts`], { cwd: join(ROOT, 'services'), env });
  if (!args.includes('--no-app')) {
    await sleep(1500);
    run('app', 97, 'npx', ['vite', '--port', '5173', '--strictPort'], { cwd: join(ROOT, 'app') });
    run('exit-app', 31, 'npx', ['vite', '--port', '5174', '--strictPort'], { cwd: join(ROOT, 'exit-app'), env: { EXIT_DEFAULT_RPC: d.rpcUrl } });
  }
  console.log(color(32, `\n✔ Rütli on Base Sepolia — app http://localhost:5173, explorer ${d.explorerUrl}\n`));
}

function shutdown() {
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error(color(31, String(e?.message ?? e)));
  shutdown();
});
