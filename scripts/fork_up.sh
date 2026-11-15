#!/usr/bin/env bash
# Local anvil fork of Aevum testnet 44005 with Brake deployed — for runs while the live wallets are unfunded.
# Everything it produces is labelled FORK: the txs exist only on this local fork, never on explorer-test.qday.info.
# usage: scripts/fork_up.sh            (keys from ~/.config/brake/wallets.env; never printed)
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_UPSTREAM=${RPC_UPSTREAM:-https://rpc-test.qday.info}
PORT=${FORK_PORT:-8545}
FORK=http://127.0.0.1:$PORT
FUNDER=${FORK_FUNDER:-0x693E322361bdBC101F4028596e89aAcE407Bb09f} # an existing tUSD8 holder, impersonated on the fork only
TUSD8=0x456569838f1d43009A91ebA4263147Afd7233483
FUND_UNITS=${FORK_FUND_UNITS:-20000000} # 20 tUSD8 to the demo payer

set -a; source "$HOME/.config/brake/wallets.env"; set +a

if ! cast chain-id --rpc-url "$FORK" >/dev/null 2>&1; then
  anvil --fork-url "$RPC_UPSTREAM" --port "$PORT" --block-time 1 --chain-id 44005 --silent >/tmp/brake-anvil.log 2>&1 &
  echo "anvil pid $! (log /tmp/brake-anvil.log)"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$FORK" >/dev/null 2>&1 && break; sleep 0.5; done
fi
echo "fork block $(cast block-number --rpc-url "$FORK")"

for a in "$DEPLOYER_ADDRESS" "$DEMO_PAYER_ADDRESS" "$AGENT_ADDRESS" "$KEEPER_ADDRESS" "$FUNDER"; do
  cast rpc anvil_setBalance "$a" 0x8AC7230489E80000 --rpc-url "$FORK" >/dev/null # 10 QDAY gas
done

forge clean >/dev/null && forge build >/dev/null
DEPLOY_MODE=fork forge script script/Deploy.s.sol --rpc-url "$FORK" --broadcast --slow >/tmp/brake-deploy.log 2>&1 \
  || { tail -30 /tmp/brake-deploy.log; exit 1; }
RPC=$FORK script/check_deploy.sh evidence/deploy-44005-fork.json

cast rpc anvil_impersonateAccount "$FUNDER" --rpc-url "$FORK" >/dev/null
cast send "$TUSD8" 'transfer(address,uint256)' "$DEMO_PAYER_ADDRESS" "$FUND_UNITS" --from "$FUNDER" --unlocked --rpc-url "$FORK" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$FUNDER" --rpc-url "$FORK" >/dev/null
echo "demo payer tUSD8 (fork): $(cast call "$TUSD8" 'balanceOf(address)(uint256)' "$DEMO_PAYER_ADDRESS" --rpc-url "$FORK")"
