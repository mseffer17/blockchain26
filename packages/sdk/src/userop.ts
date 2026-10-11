import {
  concatHex,
  encodeFunctionData,
  hashTypedData,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { rutliAccountAbi, rutliFactoryAbi } from './abis';
import { ENTRYPOINT_DOMAIN } from './constants';
import type { PackedUserOp, SerializedUserOp } from './types';

const UINT128_MAX = (1n << 128n) - 1n;

/** abi.encodePacked(uint128 high, uint128 low) */
export function packUint128Pair(high: bigint, low: bigint): Hex {
  if (high < 0n || low < 0n || high > UINT128_MAX || low > UINT128_MAX) throw new Error('uint128 overflow');
  return pad(toHex((high << 128n) | low), { size: 32 });
}

export function unpackUint128Pair(packed: Hex): { high: bigint; low: bigint } {
  const v = BigInt(packed);
  return { high: v >> 128n, low: v & UINT128_MAX };
}

export const packAccountGasLimits = (verificationGasLimit: bigint, callGasLimit: bigint) =>
  packUint128Pair(verificationGasLimit, callGasLimit);

export const packGasFees = (maxPriorityFeePerGas: bigint, maxFeePerGas: bigint) =>
  packUint128Pair(maxPriorityFeePerGas, maxFeePerGas);

/** Full 256-bit EntryPoint nonce from a 192-bit key ("lane") and a 64-bit sequence. */
export function nonceFor(key: bigint, sequence: bigint): bigint {
  return (key << 64n) | sequence;
}

/** initCode for a counterfactual account: factory address ++ createAccount calldata. */
export function buildInitCode(factory: Address, cfg: InitConfig, userSalt: Hex): Hex {
  return concatHex([
    factory,
    encodeFunctionData({ abi: rutliFactoryAbi, functionName: 'createAccount', args: [cfg, userSalt] }),
  ]);
}

export interface InitConfig {
  passkeyX: Hex;
  passkeyY: Hex;
  card: Address;
  cosigner: Address;
  guardian: Address;
  recoveryDelay: number;
  exitDelay: number;
  allowanceTokens: readonly Address[];
  allowanceLimits: readonly bigint[];
}

export function emptyUserOp(sender: Address, nonce: bigint, callData: Hex): PackedUserOp {
  return {
    sender,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits: packAccountGasLimits(0n, 0n),
    preVerificationGas: 0n,
    gasFees: packGasFees(0n, 0n),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/**
 * ERC-4337 v0.8 userOpHash: EIP-712 typed data hash under the EntryPoint domain.
 * Identical to `EntryPoint.getUserOpHash(op)` (verified against the contract in scripts/e2e.ts).
 */
export function getUserOpHash(op: PackedUserOp, entryPoint: Address, chainId: number): Hex {
  return hashTypedData({
    domain: { ...ENTRYPOINT_DOMAIN, chainId, verifyingContract: entryPoint },
    types: {
      PackedUserOperation: [
        { name: 'sender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'initCode', type: 'bytes' },
        { name: 'callData', type: 'bytes' },
        { name: 'accountGasLimits', type: 'bytes32' },
        { name: 'preVerificationGas', type: 'uint256' },
        { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterAndData', type: 'bytes' },
      ],
    },
    primaryType: 'PackedUserOperation',
    message: {
      sender: op.sender,
      nonce: op.nonce,
      initCode: op.initCode,
      callData: op.callData,
      accountGasLimits: op.accountGasLimits,
      preVerificationGas: op.preVerificationGas,
      gasFees: op.gasFees,
      paymasterAndData: op.paymasterAndData,
    },
  });
}

export function serializeUserOp(op: PackedUserOp): SerializedUserOp {
  return { ...op, nonce: op.nonce.toString(), preVerificationGas: op.preVerificationGas.toString() };
}

export function deserializeUserOp(op: SerializedUserOp): PackedUserOp {
  return { ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas) };
}

/** Tuple form for viem `writeContract({ functionName: 'handleOps', args: [[toTuple(op)], beneficiary] })`. */
export function toEntryPointTuple(op: PackedUserOp) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  } as const;
}

// ── Call data builders for RutliAccount ────────────────────────────────────────

export const accountCall = {
  spend: (token: Address, to: Address, amount: bigint) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'spend', args: [token, to, amount] }),
  execute: (target: Address, value: bigint, data: Hex) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'execute', args: [target, value, data] }),
  executeBatch: (calls: { target: Address; value: bigint; data: Hex }[]) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'executeBatch', args: [calls] }),
  rotatePasskey: (x: Hex, y: Hex) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'rotatePasskey', args: [x, y] }),
  rotateCard: (card: Address) => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'rotateCard', args: [card] }),
  setCosigner: (a: Address) => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'setCosigner', args: [a] }),
  setGuardian: (a: Address) => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'setGuardian', args: [a] }),
  setAllowance: (token: Address, limit: bigint) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'setAllowance', args: [token, limit] }),
  setDelays: (recovery: number, exit: number) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'setDelays', args: [recovery, exit] }),
  freeze: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'freeze' }),
  unfreeze: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'unfreeze' }),
  initiateRecovery: (x: Hex, y: Hex, newCard: Address, reasonHash: Hex) =>
    encodeFunctionData({ abi: rutliAccountAbi, functionName: 'initiateRecovery', args: [x, y, newCard, reasonHash] }),
  cancelRecovery: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'cancelRecovery' }),
  initiateExit: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'initiateExit' }),
  cancelExit: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'cancelExit' }),
  finalizeRecovery: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'finalizeRecovery' }),
  finalizeExit: () => encodeFunctionData({ abi: rutliAccountAbi, functionName: 'finalizeExit' }),
};
