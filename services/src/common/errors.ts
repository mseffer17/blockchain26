import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from 'viem';
import { entryPointAbi, mockUsdcAbi, rutliAccountAbi } from '@rutli/sdk';

const ERROR_ABIS = [...rutliAccountAbi, ...mockUsdcAbi].filter((x) => x.type === 'error');

const FRIENDLY: Record<string, string> = {
  AllowanceExceeded: 'Daily wallet limit reached: use your vault (Face ID + Swissquote, or Face ID + card).',
  AccountFrozen: 'Face-ID-only spending is frozen (theft report). Use your card, or replace your passkey.',
  NoAllowance: 'This token has no daily wallet allowance.',
  SelfCallForbidden: 'A wallet cannot call its own security functions through a transfer.',
  NotReady: 'The security delay has not elapsed yet.',
  NothingPending: 'Nothing is pending.',
  StaleRequest: 'This request was voided by a later key change.',
  SovereignMode: 'The wallet is in sovereign mode (Swissquote removed).',
  ERC20InsufficientBalance: 'Insufficient USDC balance.',
  InvalidAddress: 'Invalid address.',
  DuplicateKey: 'A key cannot serve as two different factors.',
};

/** Decode a revert payload from the account / token into a readable message. */
export function decodeRevert(data: Hex | undefined): { name: string; message: string; args?: readonly unknown[] } {
  if (!data || data === '0x') return { name: 'Reverted', message: 'The operation reverted.' };
  try {
    const d = decodeErrorResult({ abi: ERROR_ABIS, data });
    return { name: d.errorName, message: FRIENDLY[d.errorName] ?? d.errorName, args: d.args };
  } catch {
    return { name: 'Reverted', message: `The operation reverted (${data.slice(0, 10)}).` };
  }
}

const AA: Record<string, string> = {
  AA24: 'The signatures do not satisfy the wallet rules for this action (the pact refused it).',
  AA25: 'This operation was already used or superseded (nonce). Please retry.',
  AA21: 'The wallet cannot pay for gas and no sponsorship was attached.',
  AA22: 'The operation expired.',
  AA23: 'The wallet rejected the operation during validation.',
  AA31: "Swissquote's gas budget is exhausted.",
  AA32: 'The gas sponsorship expired. Please retry.',
  AA33: 'The paymaster rejected the operation.',
  AA34: 'The gas sponsorship signature is invalid (the operation was modified after sponsorship).',
  AA10: 'The wallet already exists.',
  AA13: 'Wallet deployment failed.',
};

/** Extract an EntryPoint FailedOp reason ("AA24 signature error") from a viem error. */
export function entryPointFailure(err: unknown): { code: string; reason: string; message: string } | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  let reason: string | undefined;
  if (revert?.data?.errorName === 'FailedOp' || revert?.data?.errorName === 'FailedOpWithRevert') {
    reason = String(revert.data.args?.[1] ?? '');
  } else if (revert?.raw) {
    try {
      const d = decodeErrorResult({ abi: entryPointAbi, data: revert.raw });
      if (d.errorName === 'FailedOp' || d.errorName === 'FailedOpWithRevert') reason = String(d.args?.[1]);
    } catch {
      /* not an EntryPoint error */
    }
  }
  if (!reason) {
    const m = /AA\d\d [^"'\n]*/.exec(err.message);
    if (m) reason = m[0];
  }
  if (!reason) return null;
  const code = reason.slice(0, 4);
  return { code, reason, message: AA[code] ?? reason };
}

/** Find the revert payload anywhere in a viem error chain (estimateGas / call / simulate errors). */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let e = err as { data?: unknown; raw?: unknown; cause?: unknown; message?: string } | undefined;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (typeof e.raw === 'string' && e.raw.startsWith('0x')) return e.raw as Hex;
    if (typeof e.data === 'string' && e.data.startsWith('0x')) return e.data as Hex;
    if (e.data && typeof e.data === 'object' && typeof (e.data as { data?: unknown }).data === 'string') {
      return (e.data as { data: Hex }).data;
    }
    e = e.cause as typeof e;
  }
  const m = /(0x[0-9a-fA-F]{8,})/.exec(String((err as Error | undefined)?.message ?? ''));
  return m?.[1] as Hex | undefined;
}
