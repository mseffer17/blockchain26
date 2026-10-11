# Legal feasibility (Switzerland)

*Engineering analysis written to survive a conversation with a lawyer. It is not legal advice; the conclusions should be
confirmed with FINMA, for example through a ruling request.*

## 1. Is it custody?

**The test.** Custody depends on who can move the funds. If Swissquote can dispose of the client's crypto-assets on its
own, it holds them in custody, with the capital, segregation and bankruptcy rules that come with it (since the DLT
Act, crypto-assets held in custody are segregated in a bank's bankruptcy, art. 242a SchKG/LP). If it cannot act alone,
the wallet is closer to software.

**Rütli's position: non-custodial.** This is verifiable on-chain, not a contractual promise:

1. **Swissquote alone** (factor S) can only freeze Face-ID spending for 72 hours. It cannot transfer, approve, replace a
   key, or block the client's other routes. `canAuthorize(execute, S) == false`.
2. **Swissquote cannot prevent the client from leaving.** Face ID + card works without Swissquote, and the card alone
   exits after 30 days. Swissquote is not a gatekeeper: it cannot "lock in" the assets.
3. **The contract is immutable.** Swissquote has no upgrade key.

**The grey zone: Swissquote together with La Poste.** Together they can start one specific operation, replacing both
client keys. We argue this is not power of disposal over the assets:

- it never moves funds;
- it only executes after a 7-day public delay;
- the client cancels it unilaterally with one Face ID or with the card, even with a plain transaction if Swissquote
  refuses to relay it;
- La Poste is an independent institution, bound by its own procedures (letter to the registered address, its own
  signature), and signs only the exact recovery of an open case;
- every attempt is announced on-chain and pushed by an open-source watchtower to all the client's channels.

Disposal "against the will of the client" is therefore impossible for a client who keeps at least one of their two
factors. The residual case is a client who lost both, which is exactly the case the route exists for, as in
inheritance.

**AMLA.** Swissquote is a bank and applies AMLA anyway. For what it co-signs, it applies its usual controls: sanctions
screening, monitoring, and Travel Rule classification. Whether co-signing alone constitutes financial intermediation
does not change the conclusion on custody. Swissquote does not need a new licence, and the wallet adds no custodial
liability to its balance sheet.

## 2. Travel Rule and self-hosted wallets

Switzerland applies the Travel Rule strictly: FINMA Guidance 02/2019 and art. 10 AMLO-FINMA, with no de-minimis
threshold. A Swiss institution may send crypto to, or receive it from, an external self-hosted wallet only after
verifying, by technical means, who controls it.

**How Rütli makes the check automatic.** During onboarding, inside an authenticated banking session, the passkey signs
a domain-separated statement:

`keccak256(abi.encode("RUTLI_WALLET_OWNERSHIP_PROOF_V1", clientId, account, chainId, nonce))`

Swissquote verifies the P-256 signature against the passkey that the wallet address itself commits to: the
CREATE2 address is derived from the full key configuration. That is proof of control by technical means, recorded in
the Travel Rule registry. There is no screenshot, no test transfer and no manual review.

| Flow | Who is the institution | What happens |
|---|---|---|
| Swissquote account → own Rütli wallet | Swissquote is the ordering institution | Beneficiary = the client, ownership verified at creation: instant |
| Own Rütli wallet → Swissquote account | Swissquote is the beneficiary institution | Origin = the client's verified wallet: credited instantly |
| Rütli wallet → a person | The client signs and broadcasts; **Swissquote is not the ordering institution** | Swissquote screens what it co-signs (risk-based), as a service |
| Rütli wallet → another exchange or bank | Not Swissquote | The receiving institution must verify the self-hosted sender: the client presents Swissquote's **wallet-ownership credential** |
| Swissquote account → any other external wallet | Swissquote | Today's manual verification (shown in the app as the contrast) |

**The wallet-ownership credential.** An SD-JWT verifiable credential, the format of the Swiss e-ID wallet *swiyu*, signed
by Swissquote. It states that this self-hosted wallet belongs to a client Swissquote identified under AMLA, with selective
disclosure (name, date of birth and nationality only if the client chooses). Another institution verifies it in
milliseconds and checks the wallet on-chain. Swissquote becomes the trust anchor for self-hosted wallet ownership in
Switzerland.

## 3. Banking secrecy and data protection

- **No personal data on-chain.** The chain sees keys, never names (art. 47 BankG/LB banking secrecy).
- **Unlinkable clients.** The co-signer and guardian keys are derived per client, so no common "Swissquote" key
  appears in every wallet and the chain cannot be scanned for "all Swissquote clients". An observer can tell that an
  address is a Rütli wallet (as one can tell a Safe), not whose it is.
- **Biometrics never leave the phone** (WebAuthn). Video identification results reach Swissquote only as a signed yes
  or no from the provider (nFADP/nLPD data minimisation).
- **Selective disclosure** in the ownership credential.

## 4. Identification, recovery and inheritance

- **Video identification** follows the logic of FINMA Circular 2016/7 (video and online identification).
- **The Swiss e-ID** (planned by the Federal Council for 1 December 2026) can replace it as a strong identity signal
  for onboarding and recovery.
- **La Poste** independently checks access to the registered postal address, a channel a phone or e-mail thief does
  not control.
- **Inheritance.** Heirs acquire the estate by universal succession (art. 560 CC) and prove it with a certificate of
  inheritance (art. 559 CC). The same S+G route moves control to the heirs' keys after the delay, with the evidence
  committed on-chain (`reasonHash`).

## 5. Sanctions

Swissquote's infrastructure does not relay or sponsor operations involving addresses on the OFAC SDN list or matching
SECO measures (Embargo Act). This is mocked with a static list here; in production a provider such as Chainalysis or
Elliptic would be used. In self-custody, the chain itself does not prevent a client from using another relayer: Swissquote does
not facilitate, and the client bears the responsibility. That is the honest boundary of self-custody.

## 6. Open questions for FINMA

1. Confirm that a co-signer without unilateral power of disposal, plus a delayed and vetoable institutional recovery
   route, is not custody under the Banking Act.
2. Confirm that the passkey ownership proof bound to the CREATE2 address meets the "technical means" requirement of
   Guidance 02/2019.
3. The status of the guardian (La Poste): an outsourced service of Swissquote, or an independent service the client
   chooses? Independence strengthens point 1.
