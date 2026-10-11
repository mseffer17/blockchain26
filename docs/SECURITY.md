# Security and custody design

## 1. The custody decision

**Model: non-custodial smart account with four independent factors and time-locked institutional routes.**
The client holds two factors (passkey, paper card). Swissquote holds one (co-signer). An independent Swiss institution
holds the fourth (guardian). The rules are immutable code.

### Alternatives considered

| Model | Why not alone |
|---|---|
| Custodial account | It is what Swissquote already offers. The client gains nothing; Swissquote keeps the balance-sheet and segregation burden of custody. |
| Seed phrase | Requires a typical client to keep 24 words safe forever, and loss is final. One stolen phrase means everything stolen. |
| MPC / threshold signatures | Chain-agnostic (Bitcoin too), but the policy is off-chain. Swissquote's share server enforces "delays" and "limits" by promise. Swissquote and the backup holder together can sign instantly: the grey zone the challenge warns about, with no on-chain veto. |
| Split backup (Shamir / SLIP-39) | The seed is reassembled somewhere at recovery time; any two holders (Swissquote + partner) can rebuild it without the client. |
| Pure ERC-4337 + passkey | Good UX, but a passkey is bound to a domain name. If swissquote.ch or its app disappears, the passkey becomes unusable, so a passkey-only wallet fails the "Swissquote is gone" test. |

**Rütli combines the strengths:**

- passkey UX for daily use;
- a paper key that any software can use forever;
- an institutional route that is slow, public and vetoable;
- rules enforced by the chain, which the regulator and the client can verify with `canAuthorize`.

### Pros and cons

| Pros | Cons |
|---|---|
| Swissquote cannot move funds, alone or with La Poste | EVM-only as implemented (see roadmap: the same policy in Bitcoin Miniscript) |
| The client never depends on Swissquote (P+C route, card exit) | Custom policy contract: needs an audit before production |
| A phone thief gets at most the daily allowance | A careless client who loses the card without replacing it weakens the collusion defence (see residual risks) |
| Recovery without any seed phrase for the client to manage | Off-chain cool-off and screening rely on Swissquote's service (by design: they are services, not custody) |
| Travel Rule ownership proof is automatic and cryptographic | |
| Gasless; no ETH ever needed in normal life | |

## 2. Key custody

| Factor | Generated | Stored | Signs | Production |
|---|---|---|---|---|
| P passkey (P-256) | the phone's authenticator | Secure Enclave / StrongBox; may sync via iCloud/Google | WebAuthn assertion over the `userOpHash` | same |
| C card (secp256k1) | the client's browser (BIP-39, 128 bits) | paper at home | raw ECDSA over the `userOpHash` | NFC card or hardware wallet as an option |
| S co-signer (secp256k1) | Swissquote, derived per client `m/44'/60'/0'/0/i` | `services/data/<net>/sq-cosigner/keys.json` | after policy checks | HSM; key rotation with `setCosigner` (P+S) |
| G guardian (secp256k1) | La Poste, derived per client | `services/data/<net>/poste-guardian/keys.json` | only `initiateRecovery` of an open case | La Poste's HSM |

There is no master key and no seed phrase for the wallet as a whole. The card is one factor among four.

## 3. Threat model

Who could steal funds, who could lock the client out, and could Swissquote, alone or with a partner, move the funds?

| Attacker | Has | Gets | Why |
|---|---|---|---|
| Phone thief who watched the passcode ("bar thief") | phone, passcode, synced passkey, e-mail, banking session | **at most the daily allowance** (1'000 USDC) | Vault needs S or C. Swissquote holds first-time large transfers, freezes on the hotline call, and refuses after a theft report. Guardian recovery needs a face (video-ident) and a mailbox (letter). |
| SIM-swapper / e-mail hijacker | SMS, e-mail | nothing | No factor is an SMS or an e-mail. |
| Malicious dApp / drainer | a signature request | nothing with Face ID alone | `spend` is the only P-only function: no approvals, no calls. With P+S, the co-signer refuses unlimited approvals and unapproved contracts. |
| Malware on the phone (blind signing) | can request signatures | up to the allowance | The co-signer independently decodes and simulates what it co-signs. |
| Rogue Swissquote employee / Swissquote hacked | key S | nothing | S alone: freeze only. S+G: delayed recovery that the client cancels. |
| Swissquote + La Poste collude (grey zone) | S + G | a **public, 7-day** recovery attempt | Cancellable by the client's passkey or card. The card can cancel with a plain transaction even if Swissquote refuses to relay. The watchtower alerts everyone. |
| Burglar | card | a 30-day exit attempt, or C+S rotation if they also fool video-ident | The client cancels the exit with Face ID. Rotating the card (P+S) voids any pending exit. |
| Swissquote bankrupt or gone | — | — | The exit app plus the card plus a public RPC: 30 days, then full control. No Swissquote domain, server or paymaster needed. |
| Client dies | — | — | Heirs: the same S+G route with a certificate of inheritance (art. 559 CC) as evidence (`reasonHash`), after the delay. |
| Coercion ("$5 wrench") | the client | the allowance, or a first-time large transfer after the 24 h cool-off | Delays make coercion unattractive. A duress mode is on the roadmap. |

**Who can lock the client out?** Nobody permanently:

- Swissquote can refuse to co-sign, but P+C always works.
- Swissquote can freeze, but only P-only spending, for 72 h, and the client can unfreeze with P+C.
- A thief can freeze too: that is a nuisance, not a lock-out.

**Residual risks (accepted, documented):**

- A client who lost the card and does not replace it (one P+S operation) is exposed to an S+G collusion that the
  passkey can still cancel.
- Passkey sync means an Apple/Google account takeover equals a phone theft, which the allowance and cool-off bound.
- Losing P and C while Swissquote has disappeared leaves no route. We recommend a second card in a bank safe-deposit box.

## 4. Design details that matter

- **Signatures only through OpenZeppelin.** `ECDSA.tryRecoverCalldata` (low-s enforced), `WebAuthn.verify` with
  `requireUV = true`, and `P256.verify` (precompile or Solidity fallback, low-s enforced). The contract contains policy,
  never cryptography.
- **Factor blob.** The blob is `count | (factor | size | data)*`. Every length is checked and the decoder never reverts.
  Duplicate, unknown or composite factor ids and trailing bytes all invalidate the whole signature, and one bad entry
  voids everything. Keys must be pairwise distinct, so one key can never count as two factors.
- **Validation vs execution (ERC-7562).** Validation only checks signatures and the selector-to-factor rule. Timestamps,
  delays, freezes and allowances are enforced in execution.
- **No self-calls.** `execute` cannot target the account itself. Otherwise P+S could reach functions reserved to P+C,
  such as `setGuardian` or `setAllowance`.
- **ERC-1271 needs full authority.** A permit signed by the passkey alone would bypass the allowance. Signatures are bound
  to the account (EIP-712 `replaySafeHash`), so there is no cross-account replay.
- **Epochs.** Every key change increments `securityEpoch` and voids pending requests. Examples: a card rotation kills a
  stolen-card exit, and a finalized recovery kills a pending exit.
- **Immutability.** The account is an EIP-1167 clone with no upgrade path: nobody can change a deployed account's rules.
  The CREATE2 salt commits to the full configuration, so a front-runner cannot squat an address with other keys.
- **Paymaster.** The sponsorship signature is EIP-712, bound to sender, nonce, initCode, callData, all gas fields and
  validity, plus the paymaster address and chain id. It must be time-bounded (`validUntil = 0` is rejected).
- **Nonce lanes.** Separate 192-bit nonce keys for daily payments, vault operations and security operations, so a
  thief's daily payments cannot invalidate Swissquote's prepared freeze, or vice versa.
- **No signing oracle.** The co-signer verifies the client's own factor (passkey or card) off-chain before adding its
  signature, and recomputes the `userOpHash` itself. The app also recomputes the hash before every Face ID.

## 5. How it is verified

| Property | Test |
|---|---|
| The authorization table equals the documented pact (all selectors × 16 masks, normal and sovereign) | `AuthorizationMatrix.t.sol` |
| Swissquote, the guardian, or both, can never move funds (unit, end to end through the EntryPoint) | `test_Institutions_CanNeverMoveFunds`, `test_Matrix_EndToEnd_*` |
| With an attentive client, an adversary holding S and G can never move funds or replace keys (2'048 random calls, 64 runs) | `InstitutionsAdversary.invariant.t.sol` |
| The allowance never exceeds the daily limit (fuzz) | `testFuzz_Spend_NeverExceedsAllowance` |
| Signature hardening: duplicates, truncation, trailing bytes, wrong key, high-s, missing UV, replay | `test_Signature_*` |
| The whole story on-chain | `Story.t.sol` |
| The whole story through the services | `scripts/e2e.ts` |
| The whole story in the browser with real WebAuthn | `scripts/ui-test.ts` |

Coverage: `RutliAccount.sol` 94 % lines, `RutliPaymaster.sol` 100 % lines (`forge coverage --ir-minimum`).

## 6. Before production

- Independent audit of the three contracts; formal verification of `canAuthorize` against the table.
- HSMs for S and G; key ceremonies; a co-signer key-rotation runbook (`setCosigner` with P+S).
- Public ERC-4337 mempool: stake the paymaster and make its signer immutable (ERC-7562 storage rules).
- Device-bound passkeys for high-value approvals (native app with App Attest / Play Integrity), duress PIN.
- Bitcoin: the same pact in Miniscript (Liana-style), e.g. `or_d(multi(2,P,S,C),and_v(v:pk(C),older(4320)))`, where
  `older(4320)` is about 30 days of blocks and P is a secp256k1 key sealed on the phone by the passkey (WebAuthn PRF).
  An MPC wallet is not the only way to support Bitcoin: its script supports keys and timelocks natively.
