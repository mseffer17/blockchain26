import type { Address, Hex } from 'viem';

/** ERC-4337 v0.8 PackedUserOperation (the struct the EntryPoint takes). */
export interface PackedUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  /** abi.encodePacked(uint128 verificationGasLimit, uint128 callGasLimit) */
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  /** abi.encodePacked(uint128 maxPriorityFeePerGas, uint128 maxFeePerGas) */
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/** JSON-safe representation (bigints as decimal strings) used between the app and the services. */
export interface SerializedUserOp {
  sender: Address;
  nonce: string;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: string;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export type NetworkName = 'local' | 'base-sepolia';

/** Written by scripts/setup.ts to deployments/<network>.json and read by every component. */
export interface Deployment {
  network: NetworkName;
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  /** true if the RIP-7212 / EIP-7951 P-256 precompile is available (cheaper passkey verification). */
  p256Precompile: boolean;
  contracts: {
    entryPoint: Address;
    implementation: Address;
    factory: Address;
    paymaster: Address;
    usdc: Address;
    vault: Address;
    scam: Address;
  };
  /** Swissquote-side addresses that are public by nature. */
  addresses: {
    omnibus: Address; // Swissquote's omnibus (custodial) hot wallet = deposit address for "send back to my account"
    bundler: Address;
    sponsor: Address;
    scammer: Address;
  };
  params: {
    minDelay: number;
    freezeDuration: number;
    recoveryDelay: number;
    exitDelay: number;
    dailyLimitUsdc: string; // in USDC base units (6 decimals)
    holdSeconds: number; // co-signer cool-off for a new recipient above the threshold
    holdThresholdUsdc: string;
  };
  services: {
    sqCore: string;
    cosigner: string;
    poste: string;
    videoIdent: string;
    gasStation: string;
    watchtower: string;
  };
  deployedAt: number;
}

/** What the passkey produced, as encoded in the factor signature. */
export interface WebAuthnAssertion {
  r: bigint;
  s: bigint;
  challengeIndex: number;
  typeIndex: number;
  authenticatorData: Hex;
  clientDataJSON: string;
}

export interface PasskeyPublicKey {
  x: Hex;
  y: Hex;
}
