# Vendored: ERC-8004 reference registries

Third-party code, copied unmodified (not written for Brake).

- Source: https://github.com/erc-8004/erc-8004-contracts
- Commit: `b9e466c250744a7e06b13dff9d3c2844ed64f825` (2026-08-15)
- Files: `contracts/IdentityRegistryUpgradeable.sol`, `contracts/ValidationRegistryUpgradeable.sol`
- Licence: repository README says CC0 (public domain); the file headers say `SPDX-License-Identifier: MIT`.
  Both permit redistribution inside this MIT repository.
- Upstream note: the Validation Registry is described upstream as still under active update; this pin is one
  snapshot, not a final standard.

Brake deploys them behind OpenZeppelin `ERC1967Proxy` through `src/ERC8004Bootstrap.sol` (written for Brake: the
upstream placeholder implementation hardcodes the upstream deployer as owner).
