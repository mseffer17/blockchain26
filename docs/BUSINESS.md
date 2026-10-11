# Business case for Swissquote

## The problem in numbers

- At the end of H1 2026, Swissquote had **1'220'818 accounts** and **CHF 96.3 bn** of client assets.
- Its net crypto-asset income fell **66 %** to **CHF 14.6 m** in H1 2026, after CHF 85.7 m for all of 2025.
- Crypto revenue today depends on trading volumes, which are volatile.
- Clients who want self-custody withdraw to MetaMask or Ledger and leave: their assets and their future trading fees
  leave too.

Sources: Swissquote 2025 annual report (shareholders' letter); Finance Magnates, 13 August 2026 (H1 2026 results).

## What Swissquote gains

1. **Retention.** The wallet is self-custody but one tap from the bank account. Moving back to sell is instant because
   ownership was verified at creation, so trading revenue stays with Swissquote instead of moving to an exchange.
2. **Recurring, volume-independent revenue.**
   - **Rütli Premium** (CHF 4.90 a month): inheritance planning, assisted recovery with La Poste, and cover of the daily
     wallet against theft (at most CHF 1'000 per incident, by construction).
   - **Swap and dApp fee** on approved protocols (0.5 %; MetaMask charges 0.875 %).
3. **Lower costs.**
   - Automatic Travel Rule ownership checks replace manual reviews of withdrawal addresses.
   - No "I lost my seed phrase" tickets: the product has no seed phrase.
4. **New clients.** Crypto-natives who want self-custody but also a Swiss-grade recovery. Yuh (Swissquote and
   PostFinance, about 400'000 accounts) is a natural second channel. PostFinance's parent, La Poste, is the natural guardian.
5. **A B2B position.**
   - **White label** for cantonal and private banks that cannot build this themselves.
   - The **ownership credential** makes Swissquote the trust anchor that other institutions query.

## Illustrative model (assumptions to validate)

| Line | Assumption | Per year |
|---|---|---|
| Adoption | 3 % of accounts, about 36'600 wallets | — |
| Rütli Premium | 20 % of wallets × CHF 4.90 × 12 | ≈ CHF 0.43 m |
| Swap / dApp fees | CHF 5'000 per wallet per year × 0.5 % | ≈ CHF 0.92 m |
| Gas sponsorship (cost) | 10 operations per month × CHF 0.02 on an L2 | ≈ −CHF 0.09 m |
| Recovery operations (cost) | identification and letters, mostly paid by Premium | marginal |
| **Direct contribution** | | **≈ CHF 1.3 m** |

The larger value is indirect and harder to quantify:

- crypto assets that no longer leave the ecosystem;
- trading fees on those assets;
- cross-selling;
- white-label licences.

## Why it is credible to launch

- No new licence and no new custody liability: the wallet is non-custodial software (see [LEGAL.md](LEGAL.md)).
- Built on standards: ERC-4337, WebAuthn, EIP-712, and SD-JWT (the format of the Swiss e-ID).
- Every institutional role is something Swiss institutions already do: video identification, registered letters, and
  sanctions screening.
