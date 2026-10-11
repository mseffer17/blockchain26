/**
 * RÜTLI EXIT — recover a Rütli wallet with the paper recovery card ALONE.
 *
 * This page talks to nothing but a public Ethereum RPC. No Swissquote server, no bundler, no paymaster,
 * no Swissquote domain name: it is one static HTML file that anyone can host or open from disk.
 *
 *   1. Type the 12 words of the card → the card key is derived locally (never sent anywhere).
 *   2. The wallet is found on-chain from the card's address (indexed events).
 *   3. initiateExit() — a plain transaction from the card's own address.
 *   4. After the exit delay (30 days in production): finalizeExit() → sovereign mode.
 *   5. The card alone sweeps every asset to any address.
 * It can also cancel a recovery started by Swissquote + La Poste, or freeze, directly from the card.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAbiItem,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { cardAccount, formatDuration, formatUsdc, isValidCard, rutliAccountAbi, shortAddress } from '@rutli/sdk';
import './style.css';


interface WalletInfo {
  address: Address;
  card: Address;
  cosigner: Address;
  guardian: Address;
  sovereign: boolean;
  exitDelay: number;
  recoveryDelay: number;
  pendingExit: number;
  pendingRecovery: number;
  now: number;
  eth: bigint;
  tokens: Array<{ address: Address; symbol: string; decimals: number; balance: bigint }>;
}

const ZERO = '0x0000000000000000000000000000000000000000';

const s = {
  rpc: (() => {
    try {
      return localStorage.getItem('rutli-exit:rpc') ?? __DEFAULT_RPC__;
    } catch {
      return __DEFAULT_RPC__;
    }
  })(),
  chainId: 0,
  words: '',
  card: undefined as ReturnType<typeof cardAccount> | undefined,
  cardEth: 0n,
  wallets: [] as Address[],
  manual: '',
  info: undefined as WalletInfo | undefined,
  dest: '',
  busy: '',
  error: '',
  log: [] as string[],
};

let pc: PublicClient | undefined;

function client(): PublicClient {
  if (!pc) pc = createPublicClient({ transport: http(s.rpc) });
  return pc;
}

function wallet() {
  const chain = defineChain({
    id: s.chainId,
    name: `chain ${s.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [s.rpc] } },
  });
  return createWalletClient({ account: s.card!, chain, transport: http(s.rpc) });
}

const log = (line: string) => {
  s.log.unshift(`${new Date().toLocaleTimeString('de-CH')}  ${line}`);
  render();
};

async function run(label: string, fn: () => Promise<void>) {
  s.busy = label;
  s.error = '';
  render();
  try {
    await fn();
  } catch (e) {
    const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e);
    s.error = msg.split('\n')[0]!;
  } finally {
    s.busy = '';
    render();
  }
}

async function connect() {
  pc = undefined;
  s.chainId = await client().getChainId();
  try {
    localStorage.setItem('rutli-exit:rpc', s.rpc);
  } catch {
    /* optional */
  }
  log(`Connected to chain ${s.chainId} through ${s.rpc}`);
}

/** Find the wallets whose card is this card, from public events only. */
async function findWallets() {
  if (!s.chainId) await connect();
  const card = s.card!.address;
  const c = client();
  const events = ['AccountInitialized', 'CardRotated', 'RecoveryFinalized'] as const;
  const found = new Set<string>();
  for (const name of events) {
    const event = getAbiItem({ abi: rutliAccountAbi, name }) as never;
    const args = name === 'RecoveryFinalized' ? { newCard: card } : { card };
    try {
      const logs = (await c.getLogs({ event, args: args as never, fromBlock: 0n, toBlock: 'latest' })) as Array<{ address: Address }>;
      for (const l of logs) found.add(getAddress(l.address));
    } catch {
      log(`This RPC refused a full-history search for ${name}; paste your wallet address instead.`);
    }
  }
  const wallets: Address[] = [];
  for (const a of found) {
    try {
      const current = await c.readContract({ address: a as Address, abi: rutliAccountAbi, functionName: 'card' });
      if (current.toLowerCase() === card.toLowerCase()) wallets.push(a as Address);
    } catch {
      /* not a Rütli wallet */
    }
  }
  s.wallets = wallets;
  log(wallets.length ? `Found ${wallets.length} wallet(s) controlled by this card` : 'No wallet found for this card yet');
  if (wallets.length === 1) await loadInfo(wallets[0]!);
}

async function loadInfo(address: Address) {
  const c = client();
  const [d, tokens, eth, block, cardEth] = await Promise.all([
    c.readContract({ address, abi: rutliAccountAbi, functionName: 'describe' }),
    c.readContract({ address, abi: rutliAccountAbi, functionName: 'allowanceTokens' }),
    c.getBalance({ address }),
    c.getBlock({ blockTag: 'latest' }),
    c.getBalance({ address: s.card!.address }),
  ]);
  const list: WalletInfo['tokens'] = [];
  for (const t of tokens) {
    if (t === ZERO) continue;
    try {
      const [symbol, decimals, balance] = await Promise.all([
        c.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }),
        c.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }),
        c.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      ]);
      list.push({ address: t, symbol, decimals, balance });
    } catch {
      /* skip non-ERC20 */
    }
  }
  s.cardEth = cardEth;
  s.info = {
    address,
    card: d.card,
    cosigner: d.cosigner,
    guardian: d.guardian,
    sovereign: d.sovereign,
    exitDelay: Number(d.exitDelay),
    recoveryDelay: Number(d.recoveryDelay),
    pendingExit: Number(d.pendingExit.executeAfter),
    pendingRecovery: Number(d.pendingRecovery.executeAfter),
    now: Number(block.timestamp),
    eth,
    tokens: list,
  };
  render();
}

async function send(functionName: 'initiateExit' | 'finalizeExit' | 'cancelRecovery' | 'freeze') {
  const w = wallet();
  const hash = await w.writeContract({ address: s.info!.address, abi: rutliAccountAbi, functionName });
  log(`${functionName}() sent: ${hash}`);
  const r = await client().waitForTransactionReceipt({ hash });
  log(`${functionName}() ${r.status === 'success' ? 'confirmed' : 'FAILED'} in block ${r.blockNumber}`);
  await loadInfo(s.info!.address);
}

async function sweep() {
  if (!isAddress(s.dest)) throw new Error('Enter a valid destination address');
  const to = getAddress(s.dest);
  const calls: Array<{ target: Address; value: bigint; data: Hex }> = [];
  for (const t of s.info!.tokens) {
    if (t.balance > 0n) {
      calls.push({ target: t.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, t.balance] }) });
    }
  }
  if (s.info!.eth > 0n) calls.push({ target: to, value: s.info!.eth, data: '0x' });
  if (calls.length === 0) throw new Error('Nothing to sweep');
  const hash = await wallet().writeContract({ address: s.info!.address, abi: rutliAccountAbi, functionName: 'executeBatch', args: [calls] });
  log(`Sweep sent: ${hash}`);
  const r = await client().waitForTransactionReceipt({ hash });
  log(`Sweep ${r.status === 'success' ? 'confirmed' : 'FAILED'}: ${calls.length} asset(s) moved to ${to}`);
  await loadInfo(s.info!.address);
}

/** Local chain only: give the card a little ETH for gas (on a real chain: any exchange or friend). */
async function faucet() {
  await client().request({ method: 'anvil_setBalance' as never, params: [s.card!.address, `0x${parseEther('0.01').toString(16)}`] as never });
  log('Local faucet: 0.01 ETH sent to the card address');
  await loadInfo(s.info!.address);
}

async function timeTravel(seconds: number) {
  await client().request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
  await client().request({ method: 'evm_mine' as never, params: [] as never });
  log(`Local chain: clock moved forward by ${formatDuration(seconds)}`);
  await loadInfo(s.info!.address);
}

// ── rendering ──────────────────────────────────────────────────────────────────

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function render() {
  const root = document.getElementById('app')!;
  const i = s.info;
  const left = (t: number) => (i ? Math.max(0, t - i.now) : 0);
  const local = s.chainId === 31337;
  root.innerHTML = `
    <header>
      <h1>Rütli Exit</h1>
      <p class="lead">Take your money out with your paper recovery card alone. This page is a single file that talks only to a public blockchain node: it works even if Swissquote no longer exists.</p>
    </header>

    <section>
      <h2>1. Blockchain node</h2>
      <div class="row">
        <input id="rpc" value="${esc(s.rpc)}" spellcheck="false" aria-label="RPC URL" />
        <button id="connect" ${s.busy ? 'disabled' : ''}>Connect</button>
      </div>
      <p class="hint">${s.chainId ? `Connected to chain ${s.chainId}.` : 'Any public node of the chain (e.g. https://sepolia.base.org).'}</p>
    </section>

    <section>
      <h2>2. Your recovery card</h2>
      ${
        s.card
          ? `<p>Card key <code>${s.card.address}</code> derived in this page. The words never leave it.</p>
             <p class="hint">Gas for the card: ${Number(formatEther(s.cardEth)).toFixed(5)} ETH${s.cardEth === 0n ? ' — send a few cents of ETH to the address above (any exchange, any friend)' : ''}.</p>
             ${local && i ? '<button id="faucet" class="secondary">Local chain: give the card 0.01 ETH</button>' : ''}`
          : `<textarea id="words" rows="3" placeholder="The 12 words printed on your card" spellcheck="false" autocapitalize="none">${esc(s.words)}</textarea>
             <button id="use-card" ${s.busy ? 'disabled' : ''}>Use this card</button>`
      }
    </section>

    ${
      s.card
        ? `<section>
      <h2>3. Your wallet</h2>
      ${s.wallets.map((w) => `<button class="wallet ${i?.address === w ? 'is-active' : ''}" data-wallet="${w}">${w}</button>`).join('')}
      <div class="row">
        <input id="manual" placeholder="Or paste your wallet address (0x…)" value="${esc(s.manual)}" spellcheck="false" />
        <button id="load-manual" class="secondary">Load</button>
      </div>
    </section>`
        : ''
    }

    ${
      i
        ? `<section class="state">
      <h2>Wallet ${shortAddress(i.address)}</h2>
      <dl>
        <dt>Assets</dt><dd>${i.tokens.map((t) => `${t.decimals === 6 ? formatUsdc(t.balance) : t.balance.toString()} ${esc(t.symbol)}`).join('<br>') || '—'}${i.eth > 0n ? `<br>${Number(formatEther(i.eth)).toFixed(5)} ETH` : ''}</dd>
        <dt>Swissquote co-signer</dt><dd>${i.cosigner === ZERO ? 'removed' : shortAddress(i.cosigner)}</dd>
        <dt>Guardian</dt><dd>${i.guardian === ZERO ? 'removed' : shortAddress(i.guardian)}</dd>
        <dt>Mode</dt><dd>${i.sovereign ? '<strong>Sovereign: your card has full control</strong>' : 'Normal (the pact)'}</dd>
      </dl>
      ${
        i.pendingRecovery
          ? `<div class="alert"><strong>A recovery is pending</strong> (Swissquote + La Poste), executes in ${formatDuration(left(i.pendingRecovery))}. If it is not yours, cancel it now — directly from your card.
             <button id="cancel-recovery" class="danger">Cancel the recovery</button></div>`
          : ''
      }
      ${
        !i.sovereign && !i.pendingExit
          ? `<p>Start the exit: after ${formatDuration(i.exitDelay)} your card alone will control the wallet and Swissquote will be removed. If your card was stolen, your phone can cancel during the delay.</p>
             <button id="initiate" ${s.busy ? 'disabled' : ''}>Start the exit</button>`
          : ''
      }
      ${
        !i.sovereign && i.pendingExit
          ? left(i.pendingExit) > 0
            ? `<p>Exit pending: ready in <strong>${formatDuration(left(i.pendingExit))}</strong> (chain time). Come back then.</p>
               ${local ? `<button id="travel" class="secondary">Local chain: jump ${formatDuration(left(i.pendingExit))} ahead</button>` : ''}`
            : `<p>The exit delay is over.</p><button id="finalize" ${s.busy ? 'disabled' : ''}>Finalize the exit</button>`
          : ''
      }
      ${
        i.sovereign
          ? `<p>Move everything to any wallet you control:</p>
             <div class="row"><input id="dest" placeholder="Destination address (0x…)" value="${esc(s.dest)}" spellcheck="false" />
             <button id="sweep" ${s.busy ? 'disabled' : ''}>Sweep all</button></div>`
          : ''
      }
      ${!i.sovereign ? `<button id="freeze" class="secondary">Freeze Face-ID spending</button>` : ''}
    </section>`
        : ''
    }

    ${s.busy ? `<p class="busy">${esc(s.busy)}…</p>` : ''}
    ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
    ${s.log.length ? `<section><h2>Log</h2><pre>${s.log.map(esc).join('\n')}</pre></section>` : ''}
    <footer>Open source. Verify the wallet rules yourself: the contract's <code>canAuthorize</code> function is public.</footer>
  `;
  bind();
}

function bind() {
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  on('connect', () => {
    s.rpc = val('rpc').trim();
    void run('Connecting', connect);
  });
  on('use-card', () => {
    s.words = val('words');
    if (!isValidCard(s.words)) {
      s.error = 'These are not the 12 words of a recovery card.';
      render();
      return;
    }
    s.card = cardAccount(s.words);
    s.words = '';
    void run('Searching your wallet on-chain', findWallets);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-wallet]').forEach((b) =>
    b.addEventListener('click', () => void run('Loading', () => loadInfo(b.dataset.wallet as Address))),
  );
  on('load-manual', () => {
    s.manual = val('manual').trim();
    if (!isAddress(s.manual)) {
      s.error = 'Invalid address';
      render();
      return;
    }
    void run('Loading', async () => {
      if (!s.chainId) await connect();
      await loadInfo(getAddress(s.manual));
    });
  });
  on('faucet', () => void run('Funding the card', faucet));
  on('initiate', () => void run('Starting the exit', () => send('initiateExit')));
  on('finalize', () => void run('Finalizing the exit', () => send('finalizeExit')));
  on('cancel-recovery', () => void run('Cancelling the recovery', () => send('cancelRecovery')));
  on('freeze', () => void run('Freezing', () => send('freeze')));
  on('travel', () => void run('Moving the local clock', () => timeTravel(left2())));
  on('sweep', () => {
    s.dest = val('dest').trim();
    void run('Sweeping', sweep);
  });
}

function left2() {
  return s.info ? Math.max(1, s.info.pendingExit - s.info.now) : 1;
}

render();
setInterval(() => {
  if (s.info && !s.busy) void loadInfo(s.info.address).catch(() => undefined);
}, 5000);
