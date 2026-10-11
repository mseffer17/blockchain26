/**
 * Deploys the Rütli contracts and bootstraps the mocked institutions on a chain.
 *
 *   npm run setup:local            # Anvil on http://127.0.0.1:8545 (fresh: wipes services/data/local)
 *   npm run setup:base-sepolia     # needs DEPLOYER_PRIVATE_KEY (funded with Base Sepolia ETH)
 *
 * Steps: generate each service's own keys (in its own data dir) → deploy EntryPoint (if absent),
 * RutliAccount implementation, RutliFactory, RutliPaymaster, demo USDC / vault / scam → fund the paymaster
 * deposit, the bundler and the bank's omnibus wallet → write deployments/<network>.json.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const network = (arg('network') ?? 'local') as 'local' | 'base-sepolia';
const keepData = argv.includes('--keep-data');
process.env.RUTLI_NETWORK = network; // must be set before the services modules are imported

const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CANONICAL_ENTRYPOINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

const PRESETS = {
  local: {
    chainId: 31337,
    rpcUrl: process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545',
    explorerUrl: undefined as string | undefined,
    deployerKey: (process.env.DEPLOYER_PRIVATE_KEY ?? ANVIL_KEY_0) as Hex,
    // Demo timings: seconds instead of days so the whole story fits in a 5-minute pitch.
    params: { minDelay: 30, freezeDuration: 3 * 86400, recoveryDelay: 120, exitDelay: 180, holdSeconds: 60 },
    funding: { paymasterDeposit: parseEther('50'), bundler: parseEther('50'), omnibus: parseEther('10') },
  },
  'base-sepolia': {
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    deployerKey: process.env.DEPLOYER_PRIVATE_KEY as Hex,
    params: {
      minDelay: Number(process.env.MIN_DELAY ?? 60),
      freezeDuration: 3 * 86400,
      recoveryDelay: Number(process.env.RECOVERY_DELAY ?? 300),
      exitDelay: Number(process.env.EXIT_DELAY ?? 600),
      holdSeconds: Number(process.env.HOLD_SECONDS ?? 120),
    },
    funding: {
      paymasterDeposit: parseEther(process.env.PAYMASTER_DEPOSIT ?? '0.02'),
      bundler: parseEther(process.env.BUNDLER_FUNDING ?? '0.01'),
      omnibus: parseEther(process.env.OMNIBUS_FUNDING ?? '0.003'),
    },
  },
}[network];

const DAILY_LIMIT_USDC = 1_000_000_000n; // 1'000 USDC
const HOLD_THRESHOLD_USDC = 500_000_000n; // 500 USDC
const OMNIBUS_USDC = 1_000_000_000_000n; // 1'000'000 USDC of custodial client money

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = join(ROOT, 'contracts', 'out', file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}. Run "npm run build:contracts" (forge build) first.`);
  const a = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function main() {
  if (!PRESETS.deployerKey) throw new Error('Set DEPLOYER_PRIVATE_KEY (a Base Sepolia key funded with test ETH).');

  if (network === 'local' && !keepData) {
    rmSync(join(ROOT, 'services', 'data', 'local'), { recursive: true, force: true });
    console.log('• wiped services/data/local (fresh chain, fresh institutions)');
  }

  const { ensureKeys, accountOf } = await import('../services/src/common/keys');
  const sqCoreKeys = await ensureKeys('sq-core');
  await ensureKeys('sq-cosigner');
  await ensureKeys('poste-guardian');
  await ensureKeys('video-ident');
  const gasKeys = await ensureKeys('gas-station');
  const omnibus = accountOf(sqCoreKeys.omnibusPrivateKey).address;
  const bundler = accountOf(gasKeys.bundlerPrivateKey).address;
  const sponsor = accountOf(gasKeys.sponsorPrivateKey).address;
  const scammer = privateKeyToAccount(generatePrivateKey()).address; // the drainer's beneficiary (demo)
  console.log('• service keys ready (each in its own data dir)');

  const deployer = privateKeyToAccount(PRESETS.deployerKey);
  const publicClient = createPublicClient({ transport: http(PRESETS.rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== PRESETS.chainId) throw new Error(`RPC is chain ${chainId}, expected ${PRESETS.chainId}`);
  const wallet = createWalletClient({ account: deployer, transport: http(PRESETS.rpcUrl) });

  const send = async (to: Address, data: Hex | undefined, value = 0n) => {
    const hash = await wallet.sendTransaction({ to, data, value, chain: null });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`tx failed: ${hash}`);
    return r;
  };
  const deploy = async (label: string, a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: null });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (!r.contractAddress || r.status !== 'success') throw new Error(`deployment of ${label} failed`);
    const address = getAddress(r.contractAddress);
    console.log(`• ${label.padEnd(20)} ${address}`);
    return address;
  };

  // EntryPoint v0.8: reuse the canonical one when present (testnets), otherwise deploy it.
  let entryPoint: Address;
  const canonicalCode = await publicClient.getCode({ address: CANONICAL_ENTRYPOINT_V08 });
  if (canonicalCode && canonicalCode !== '0x' && process.env.FORCE_NEW_ENTRYPOINT !== 'true') {
    entryPoint = CANONICAL_ENTRYPOINT_V08;
    console.log(`• EntryPoint v0.8        ${entryPoint} (canonical)`);
  } else {
    entryPoint = await deploy('EntryPoint v0.8', artifact('EntryPoint.sol', 'EntryPoint'));
  }

  const p = PRESETS.params;
  const implementation = await deploy('RutliAccount (impl)', artifact('RutliAccount.sol', 'RutliAccount'), [
    entryPoint,
    p.minDelay,
    p.freezeDuration,
  ]);
  const factory = await deploy('RutliFactory', artifact('RutliFactory.sol', 'RutliFactory'), [implementation]);
  const paymasterArtifact = artifact('RutliPaymaster.sol', 'RutliPaymaster');
  const paymaster = await deploy('RutliPaymaster', paymasterArtifact, [entryPoint, deployer.address, sponsor]);
  const usdcArtifact = artifact('MockUSDC.sol', 'MockUSDC');
  const usdc = (process.env.USDC_ADDRESS as Address | undefined) ?? (await deploy('USDC (test)', usdcArtifact, [deployer.address]));
  const vault = await deploy('HelvetiaYieldVault', artifact('HelvetiaYieldVault.sol', 'HelvetiaYieldVault'), [usdc]);
  const scam = await deploy('ScamAirdrop (demo)', artifact('ScamAirdrop.sol', 'ScamAirdrop'), [usdc, scammer]);

  // Funding: Swissquote's gas budget, its bundler, and the bank's omnibus wallet (custodial client USDC).
  await send(paymaster, encodeFunctionData({ abi: paymasterArtifact.abi, functionName: 'deposit' }), PRESETS.funding.paymasterDeposit);
  await send(bundler, undefined, PRESETS.funding.bundler);
  await send(omnibus, undefined, PRESETS.funding.omnibus);
  if (!process.env.USDC_ADDRESS) {
    await send(usdc, encodeFunctionData({ abi: usdcArtifact.abi, functionName: 'mint', args: [omnibus, OMNIBUS_USDC] }));
  }
  console.log('• funded paymaster deposit, bundler and omnibus wallet');

  // Is the P-256 precompile (RIP-7212 / EIP-7951) available? (OpenZeppelin falls back to Solidity if not.)
  let p256Precompile = false;
  try {
    const out = await publicClient.call({
      to: '0x0000000000000000000000000000000000000100',
      data: ('0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023' +
        '0000000000000000000000000000000000000000000000000000000000000005' +
        '0000000000000000000000000000000000000000000000000000000000000001' +
        'a71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957' +
        '5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b') as Hex,
    });
    p256Precompile = !!out.data && BigInt(out.data) === 1n;
  } catch {
    p256Precompile = false;
  }
  console.log(`• P-256 precompile: ${p256Precompile ? 'available' : 'absent (Solidity fallback, more gas)'}`);

  const host = process.env.PUBLIC_HOST ?? 'http://localhost';
  const deployment = {
    network,
    chainId,
    rpcUrl: PRESETS.rpcUrl,
    explorerUrl: PRESETS.explorerUrl,
    p256Precompile,
    contracts: { entryPoint, implementation, factory, paymaster, usdc, vault, scam },
    addresses: { omnibus, bundler, sponsor, scammer },
    params: {
      minDelay: p.minDelay,
      freezeDuration: p.freezeDuration,
      recoveryDelay: p.recoveryDelay,
      exitDelay: p.exitDelay,
      dailyLimitUsdc: DAILY_LIMIT_USDC.toString(),
      holdSeconds: p.holdSeconds,
      holdThresholdUsdc: HOLD_THRESHOLD_USDC.toString(),
    },
    services: {
      sqCore: process.env.SQ_CORE_URL ?? `${host}:4000`,
      cosigner: process.env.SQ_COSIGNER_URL ?? `${host}:4100`,
      poste: process.env.POSTE_URL ?? `${host}:4200`,
      videoIdent: process.env.VIDEO_IDENT_URL ?? `${host}:4300`,
      gasStation: process.env.GAS_STATION_URL ?? `${host}:4400`,
      watchtower: process.env.WATCHTOWER_URL ?? `${host}:4500`,
    },
    deployedAt: Math.floor(Date.now() / 1000),
  };
  mkdirSync(join(ROOT, 'deployments'), { recursive: true });
  const out = join(ROOT, 'deployments', `${network}.json`);
  writeFileSync(out, JSON.stringify(deployment, null, 2) + '\n');
  console.log(`\n✔ wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
