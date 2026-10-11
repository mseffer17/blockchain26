# AI tools used

The challenge asks every team to state which AI tools it used, and for what. Complete this page with your own usage
before submitting.

| Tool | Used for |
|---|---|
| Claude (Anthropic), Claude Code environment | Explaining the challenge; designing the concept and the custody model; writing the first version of the smart contracts, their Foundry tests (unit, authorization matrix, fuzz, invariants), the TypeScript SDK, the mocked services, the React app, the exit app, the end-to-end and UI test scripts, and this documentation |
| *(your team)* | *e.g. reviewing the contracts, adapting the pitch, recording the demo video* |

**How AI output was verified**

- Contracts: 92 Foundry tests, plus `forge coverage`.
- The whole system: `npm run e2e` and `npm run test:ui`, run against a real local chain.
- Legal and market facts: checked against the sources cited in [LEGAL.md](LEGAL.md) and [BUSINESS.md](BUSINESS.md).
