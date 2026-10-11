import { decodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem';
import { helvetiaYieldVaultAbi, rutliAccountAbi, scamAirdropAbi } from './abis';
import { formatUsdc, shortAddress } from './format';

export interface DecodedCall {
  target: Address;
  value: bigint;
  data: Hex;
  selector: Hex;
  functionName?: string;
  args?: readonly unknown[];
  erc20?:
    | { kind: 'transfer'; to: Address; amount: bigint }
    | { kind: 'approve'; spender: Address; amount: bigint; unlimited: boolean }
    | { kind: 'transferFrom'; from: Address; to: Address; amount: bigint };
}

export type Intent =
  | { kind: 'spend'; token: Address; to: Address; amount: bigint }
  | { kind: 'calls'; calls: DecodedCall[] }
  | { kind: 'rotatePasskey'; x: Hex; y: Hex }
  | { kind: 'rotateCard'; card: Address }
  | { kind: 'setCosigner'; cosigner: Address }
  | { kind: 'setGuardian'; guardian: Address }
  | { kind: 'setAllowance'; token: Address; limit: bigint }
  | { kind: 'setDelays'; recoveryDelay: number; exitDelay: number }
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'initiateRecovery'; x: Hex; y: Hex; newCard: Address; reasonHash: Hex }
  | { kind: 'cancelRecovery' }
  | { kind: 'initiateExit' }
  | { kind: 'cancelExit' }
  | { kind: 'unknown'; selector: Hex };

export function decodeInnerCall(target: Address, value: bigint, data: Hex): DecodedCall {
  const call: DecodedCall = { target, value, data, selector: (data.length >= 10 ? data.slice(0, 10) : '0x') as Hex };
  if (data === '0x') return call;
  for (const abi of [erc20Abi, helvetiaYieldVaultAbi, scamAirdropAbi] as const) {
    try {
      const d = decodeFunctionData({ abi: abi as never, data }) as { functionName: string; args?: readonly unknown[] };
      call.functionName = d.functionName;
      call.args = d.args;
      if (abi === erc20Abi) {
        const a = d.args ?? [];
        if (d.functionName === 'transfer') call.erc20 = { kind: 'transfer', to: a[0] as Address, amount: a[1] as bigint };
        if (d.functionName === 'approve') {
          const amount = a[1] as bigint;
          call.erc20 = { kind: 'approve', spender: a[0] as Address, amount, unlimited: amount >= maxUint256 / 2n };
        }
        if (d.functionName === 'transferFrom')
          call.erc20 = { kind: 'transferFrom', from: a[0] as Address, to: a[1] as Address, amount: a[2] as bigint };
      }
      return call;
    } catch {
      /* try next ABI */
    }
  }
  return call;
}

/** Decode the callData of a RutliAccount user operation. */
export function decodeAccountCall(callData: Hex): Intent {
  let d: { functionName: string; args?: readonly unknown[] };
  try {
    d = decodeFunctionData({ abi: rutliAccountAbi, data: callData }) as typeof d;
  } catch {
    return { kind: 'unknown', selector: callData.slice(0, 10) as Hex };
  }
  const a = d.args ?? [];
  switch (d.functionName) {
    case 'spend':
      return { kind: 'spend', token: a[0] as Address, to: a[1] as Address, amount: a[2] as bigint };
    case 'execute':
      return { kind: 'calls', calls: [decodeInnerCall(a[0] as Address, a[1] as bigint, a[2] as Hex)] };
    case 'executeBatch':
      return {
        kind: 'calls',
        calls: (a[0] as readonly { target: Address; value: bigint; data: Hex }[]).map((c) =>
          decodeInnerCall(c.target, c.value, c.data),
        ),
      };
    case 'rotatePasskey':
      return { kind: 'rotatePasskey', x: a[0] as Hex, y: a[1] as Hex };
    case 'rotateCard':
      return { kind: 'rotateCard', card: a[0] as Address };
    case 'setCosigner':
      return { kind: 'setCosigner', cosigner: a[0] as Address };
    case 'setGuardian':
      return { kind: 'setGuardian', guardian: a[0] as Address };
    case 'setAllowance':
      return { kind: 'setAllowance', token: a[0] as Address, limit: a[1] as bigint };
    case 'setDelays':
      return { kind: 'setDelays', recoveryDelay: Number(a[0]), exitDelay: Number(a[1]) };
    case 'freeze':
      return { kind: 'freeze' };
    case 'unfreeze':
      return { kind: 'unfreeze' };
    case 'initiateRecovery':
      return {
        kind: 'initiateRecovery',
        x: a[0] as Hex,
        y: a[1] as Hex,
        newCard: a[2] as Address,
        reasonHash: a[3] as Hex,
      };
    case 'cancelRecovery':
      return { kind: 'cancelRecovery' };
    case 'initiateExit':
      return { kind: 'initiateExit' };
    case 'cancelExit':
      return { kind: 'cancelExit' };
    default:
      return { kind: 'unknown', selector: callData.slice(0, 10) as Hex };
  }
}

export interface NameBook {
  usdc: Address;
  names?: Record<string, string>; // lower-case address -> display name
}

export function nameOf(addr: Address, book: NameBook): string {
  const n = book.names?.[addr.toLowerCase()];
  return n ? `${n} (${shortAddress(addr)})` : shortAddress(addr);
}

function tokenAmount(token: Address, amount: bigint, book: NameBook): string {
  if (token.toLowerCase() === book.usdc.toLowerCase()) return `${formatUsdc(amount)} USDC`;
  if (token === '0x0000000000000000000000000000000000000000') return `${Number(amount) / 1e18} ETH`;
  return `${amount.toString()} units of ${shortAddress(token)}`;
}

/** Plain-language lines describing what an operation does ("what you see is what you sign"). */
export function describeIntent(intent: Intent, book: NameBook): string[] {
  switch (intent.kind) {
    case 'spend':
      return [`Send ${tokenAmount(intent.token, intent.amount, book)} to ${nameOf(intent.to, book)}`];
    case 'calls':
      return intent.calls.flatMap((c) => {
        const lines: string[] = [];
        if (c.value > 0n) lines.push(`Send ${Number(c.value) / 1e18} ETH to ${nameOf(c.target, book)}`);
        if (c.erc20?.kind === 'transfer')
          lines.push(`Send ${tokenAmount(c.target, c.erc20.amount, book)} to ${nameOf(c.erc20.to, book)}`);
        else if (c.erc20?.kind === 'approve')
          lines.push(
            c.erc20.unlimited
              ? `Allow ${nameOf(c.erc20.spender, book)} to take ALL your ${c.target.toLowerCase() === book.usdc.toLowerCase() ? 'USDC' : 'tokens'}, forever`
              : `Allow ${nameOf(c.erc20.spender, book)} to take ${tokenAmount(c.target, c.erc20.amount, book)}`,
          );
        else if (c.functionName === 'deposit')
          lines.push(`Deposit ${formatUsdc(c.args?.[0] as bigint)} USDC into ${nameOf(c.target, book)}`);
        else if (c.functionName === 'redeem' || c.functionName === 'withdraw')
          lines.push(`Withdraw from ${nameOf(c.target, book)}`);
        else if (c.functionName === 'claimAirdrop') lines.push(`Call "claimAirdrop" on ${nameOf(c.target, book)}`);
        else if (c.data !== '0x') lines.push(`Call ${c.functionName ?? c.selector} on ${nameOf(c.target, book)}`);
        return lines;
      });
    case 'rotatePasskey':
      return ['Replace the passkey (new phone)'];
    case 'rotateCard':
      return [`Replace the recovery card (new card ${shortAddress(intent.card)})`];
    case 'setCosigner':
      return [`Replace Swissquote's co-signer key with ${shortAddress(intent.cosigner)}`];
    case 'setGuardian':
      return [`Replace the guardian with ${shortAddress(intent.guardian)}`];
    case 'setAllowance':
      return [`Set the daily wallet limit to ${tokenAmount(intent.token, intent.limit, book)}`];
    case 'setDelays':
      return [`Set recovery delay to ${intent.recoveryDelay}s and exit delay to ${intent.exitDelay}s`];
    case 'freeze':
      return ['Freeze Face-ID-only spending'];
    case 'unfreeze':
      return ['Lift the freeze'];
    case 'initiateRecovery':
      return ['Start a delayed recovery: replace BOTH passkey and recovery card'];
    case 'cancelRecovery':
      return ['Cancel the pending recovery'];
    case 'initiateExit':
      return ['Start the exit (card-only control after the delay)'];
    case 'cancelExit':
      return ['Cancel the pending exit'];
    default:
      return [`Unknown operation ${intent.selector}`];
  }
}
