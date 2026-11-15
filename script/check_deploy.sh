#!/usr/bin/env bash
# Post-deploy check: reads the deployed state back from chain (a partial broadcast must not pass silently).
# run `forge clean && forge build` before a live deploy (a stale cache deployed old bytecode once on the fork).
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
# deployed runtime code must equal the current artifact (immutables masked) — catches a stale forge cache
code_match() { # $1 address, $2 artifact path
  cast code "$1" --rpc-url "$RPC" | python3 -c '
import json,sys
a=json.load(open(sys.argv[1]))["deployedBytecode"]; art=a["object"][2:]; on=sys.stdin.read().strip()[2:]
m={k for refs in a.get("immutableReferences",{}).values() for r in refs for k in range(r["start"]*2,(r["start"]+r["length"])*2)}
d=sum(1 for i in range(min(len(art),len(on))) if art[i]!=on[i] and i not in m)
print("match" if d==0 and len(art)==len(on) else f"MISMATCH {d} nibbles, len {len(art)} vs {len(on)}")' "$2"
}
check "brake bytecode = out/" "$(code_match "$(j brake)" out/Brake.sol/Brake.json)" "match"
exit $fail
