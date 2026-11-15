#!/usr/bin/env bash
# Post-deploy check: reads the deployed state back from chain (a partial broadcast must not pass silently).
# usage: RPC=https://rpc-test.qday.info script/check_deploy.sh evidence/deploy-44005-live.json
set -euo pipefail
DEPLOY=${1:-evidence/deploy-44005-live.json}; RPC=${RPC:-https://rpc-test.qday.info}
j() { python3 -c "import json;print(json.load(open('$DEPLOY'))['$1'])"; }
fail=0
lc() { tr "[:upper:]" "[:lower:]" <<<"$1"; }
check() { if [[ "$(lc "$2")" == "$(lc "$3")" ]]; then echo "PASS $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }
check "brake.token"        "$(cast call "$(j brake)" 'token()(address)' --rpc-url "$RPC")" "$(j token)"
check "brake.identity"     "$(cast call "$(j brake)" 'identity()(address)' --rpc-url "$RPC")" "$(j identityRegistry)"
check "brake.validation"   "$(cast call "$(j brake)" 'validation()(address)' --rpc-url "$RPC")" "$(j validationRegistry)"
check "agentId owner"      "$(cast call "$(j identityRegistry)" 'ownerOf(uint256)(address)' "$(j agentId)" --rpc-url "$RPC")" "$(j payer)"
check "agent wallet bound" "$(cast call "$(j identityRegistry)" 'getAgentWallet(uint256)(address)' "$(j agentId)" --rpc-url "$RPC")" "$(j agent)"
check "brake approved"     "$(cast call "$(j identityRegistry)" 'getApproved(uint256)(address)' "$(j agentId)" --rpc-url "$RPC")" "$(j brake)"
check "validation->identity" "$(cast call "$(j validationRegistry)" 'getIdentityRegistry()(address)' --rpc-url "$RPC")" "$(j identityRegistry)"
exit $fail
