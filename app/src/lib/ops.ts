import type { Hex } from 'viem';
import {
  deserializeUserOp,
  encodeFactorSignatures,
  getUserOpHash,
  serializeUserOp,
  type FactorSignature,
  type PackedUserOp,
  type SerializedUserOp,
} from '@rutli/sdk';
import type { AppCtx } from './app';
import { getNonce } from './chain';

/** Build an operation for the wallet, have Swissquote's gas station sponsor it, and verify its hash. */
export async function prepareOp(
  ctx: Pick<AppCtx, 'cfg' | 'pc' | 'svc'>,
  account: `0x${string}`,
  callData: Hex,
  lane: bigint,
  purpose: 'default' | 'coffre' | 'security' = 'default',
): Promise<{ op: PackedUserOp; hash: Hex }> {
  const nonce = await getNonce(ctx.pc, ctx.cfg, account, lane);
  const unsigned = serializeUserOp({
    sender: account,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits: '0x',
    preVerificationGas: 0n,
    gasFees: '0x',
    paymasterAndData: '0x',
    signature: '0x',
  });
  const r = await ctx.svc.sponsor(unsigned, purpose);
  const op = deserializeUserOp(r.op);
  // Never sign a hash we did not compute ourselves ("what you see is what you sign").
  const hash = getUserOpHash(op, ctx.cfg.contracts.entryPoint, ctx.cfg.chainId);
  if (hash !== r.userOpHash) throw new Error('Hash mismatch: refusing to sign');
  return { op, hash };
}

export function withSignatures(op: PackedUserOp, sigs: FactorSignature[]): SerializedUserOp {
  return serializeUserOp({ ...op, signature: encodeFactorSignatures(sigs) });
}
