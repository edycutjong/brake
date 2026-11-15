#!/usr/bin/env bash
# G3: verify Brake + the ERC-8004 registries on the Aevum testnet Blockscout explorer.
# usage: script/verify.sh evidence/deploy-44005-live.json
set -euo pipefail
DEPLOY=${1:-evidence/deploy-44005-live.json}
VERIFIER_URL=https://explorer-test.qday.info/api/
j() { python3 -c "import json,sys;print(json.load(open('$DEPLOY'))['$1'])"; }
common=(--chain 44005 --verifier blockscout --verifier-url "$VERIFIER_URL" --watch)
forge verify-contract "${common[@]}" "$(j brake)" src/Brake.sol:Brake \
  --constructor-args "$(cast abi-encode 'c(address,address,address)' "$(j token)" "$(j identityRegistry)" "$(j validationRegistry)")"
forge verify-contract "${common[@]}" "$(j identityImpl)" src/vendor/erc8004/IdentityRegistryUpgradeable.sol:IdentityRegistryUpgradeable
forge verify-contract "${common[@]}" "$(j validationImpl)" src/vendor/erc8004/ValidationRegistryUpgradeable.sol:ValidationRegistryUpgradeable
forge verify-contract "${common[@]}" "$(j bootstrapImpl)" src/ERC8004Bootstrap.sol:ERC8004Bootstrap
