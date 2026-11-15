# Contributing

1. Node 22, pnpm 10, Foundry.
2. `pnpm install`, `forge build`.
3. Tests: `pnpm test` (signer + engine) and `forge test` (contract; the tests pin their own fork of the Aevum testnet).
4. Typecheck: `pnpm typecheck`.
5. Keep evidence honest: any number in the docs must be reproducible from `evidence/` or `bench/`.

Pull requests need green CI and no gitleaks findings.
