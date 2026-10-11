# The 5-minute demo

**Setup.** Run `npm run dev -- --fresh` and open four browser windows side by side:

- **A** http://localhost:5173 (Claire's phone)
- **B** http://localhost:5173/?device=new-phone (her new phone, used later)
- **M** http://localhost:5173/#/mailbox (her mailbox)
- **X** http://localhost:5174 (the exit app)

Keep http://localhost:5173/#/ops open for the jury's questions.

## 0:00 The hook (20 s)

> "Tonight in a bar in Lausanne, someone watches Claire type her passcode, then steals her phone. With most wallets,
> she has just lost everything. With Rütli, the thief gets the daily wallet, and nothing else."

## 0:20 Creation (40 s), window A

1. Log in (Swissquote session), then **Create my wallet**: the seal shows the four keys.
2. **Create with Face ID**: the passkey is born in the phone's secure chip.
3. **Print your recovery card**: 12 words + QR, the only paper key.
4. **Sign with Face ID and create my wallet**: one signature proves ownership for the Travel Rule.
5. **Move to my wallet now** (5'000 USDC): instant, no screenshot, no test transfer.

## 1:00 Daily life (40 s)

1. Send 120 USDC to Marc: **Face ID alone**, done, and *the wallet holds 0 ETH* (Swissquote paid the gas).
2. Send 1'500 USDC: the vault needs Swissquote. Show the checks (sanctions, simulation, Travel Rule) and the
   **cool-off**: first large transfer to a new recipient.
3. dApps, then **Claim 500 USDC**: Swissquote's simulation shows "may take ALL your USDC" and refuses.
   > "Swissquote will not co-sign. And it is still her money: with her own card she could override it."

## 1:40 The theft (60 s)

1. In window A, switch "held by" to **Mallory**.
2. Mallory spends from the daily wallet: it works, up to the limit. One more payment is refused by the contract.
3. Mallory tries a vault transfer to herself: it is put on hold.
4. In window B, choose **My phone was stolen: freeze now** and enter her birth date. The wallet is frozen and the hold
   is cancelled.
   > "Blocking is easy. Unblocking is hard."

## 2:40 Recovery (45 s), window B

1. **New phone, I have my recovery card**, then create the passkey, use the card, and choose **Claire's face** for the
   video identification.
2. The new phone controls the wallet. In window A (Mallory), reload: *"This phone no longer controls the wallet."*
3. Optional, to show the attacker refused: on a third device choose **I lost my phone and my card**, then
   **Mallory's face**. The video identification fails. Even with a perfect deepfake, the letter goes to window M:
   Claire's mailbox.

## 3:25 Swissquote disappears (45 s)

> "Now Swissquote is gone. No servers, no website, no domain."

1. Stop the services (Ctrl-C in the terminal).
2. In window X, connect to the public RPC, type the card's words, and the exit app finds the wallet on its own.
3. **Start the exit**, then jump the local clock (30 days in production), then **Finalize** and **Sweep all**.

## 4:10 Radiographie and closing (50 s)

Window B, **Security**. *Who can move your money?* is read live from the contract (`canAuthorize`).

> "Swissquote alone: no. Swissquote and La Poste together: no, only a public 7-day request that Claire cancels with
> one Face ID. That is not a promise in our terms and conditions. It is code that nobody, Swissquote included, can
> change."

End with the business case: retention, Premium, swaps, white label, Travel Rule automation.
