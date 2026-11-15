// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IEIP3009} from "../../src/interfaces/IEIP3009.sol";

/// @notice Shared fixture: a fork of Aevum testnet (44005) at a pinned block, live tUSD8, EIP-3009 signing helpers.
abstract contract AevumFork is Test {
    IEIP3009 internal constant TUSD8 = IEIP3009(0x456569838f1d43009A91ebA4263147Afd7233483);
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant ARACHNID_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// pinned for reproducibility; the Aevum RPC is an archive node (old state served)
    uint256 internal constant FORK_BLOCK = 3_252_000;
    /// existing tUSD8 holder at FORK_BLOCK, impersonated only to fund test wallets on the fork
    address internal constant FUNDER = 0x693E322361bdBC101F4028596e89aAcE407Bb09f;

    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    struct Pay {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Cancel {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function _fork() internal {
        vm.createSelectFork(vm.rpcUrl("aevum"), FORK_BLOCK);
        assertEq(block.chainid, 44005, "not Aevum testnet");
        assertGt(address(TUSD8).code.length, 0, "tUSD8 missing on fork");
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(FUNDER);
        (bool ok, bytes memory ret) =
            address(TUSD8).call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "fund failed");
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", TUSD8.DOMAIN_SEPARATOR(), structHash));
    }

    function _signPay(uint256 pk, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (Pay memory p)
    {
        p.from = vm.addr(pk);
        p.to = to;
        p.value = value;
        p.validAfter = validAfter;
        p.validBefore = validBefore;
        p.nonce = nonce;
        bytes32 h = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, p.from, to, value, validAfter, validBefore, nonce)
        );
        (p.v, p.r, p.s) = vm.sign(pk, _digest(h));
    }

    function _signCancel(uint256 pk, bytes32 nonce) internal view returns (Cancel memory c) {
        bytes32 h = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, vm.addr(pk), nonce));
        (c.v, c.r, c.s) = vm.sign(pk, _digest(h));
    }

    function _pay(Pay memory p) internal {
        TUSD8.transferWithAuthorization(p.from, p.to, p.value, p.validAfter, p.validBefore, p.nonce, p.v, p.r, p.s);
    }
}
