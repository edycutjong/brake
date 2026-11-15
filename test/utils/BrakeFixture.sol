// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AevumFork} from "./AevumFork.sol";
import {ERC8004Deploy} from "../../script/lib/ERC8004Deploy.sol";
import {Brake} from "../../src/Brake.sol";
import {IERC8004Identity, IERC8004Validation} from "../../src/interfaces/IERC8004.sol";
import {IdentityRegistryUpgradeable} from "../../src/vendor/erc8004/IdentityRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "../../src/vendor/erc8004/ValidationRegistryUpgradeable.sol";
import {ToggleValidation} from "../mocks/ToggleValidation.sol";

/// @notice Aevum fork + vendored ERC-8004 registries + Brake + a payer whose agentId is bound to the agent key.
abstract contract BrakeFixture is AevumFork {
    Brake internal brake;
    IdentityRegistryUpgradeable internal identity;
    ValidationRegistryUpgradeable internal validation;

    uint256 internal payerPk = uint256(keccak256("brake.test.payer"));
    uint256 internal agentPk = uint256(keccak256("brake.test.agent"));
    address internal payer;
    address internal agent;
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    uint256 internal agentId;

    bytes32 internal constant RUN = keccak256("run-monday");
    uint256 internal constant AMOUNT = 1_000; // 0.001 tUSD8 per line (SEED_SCALE-sized)
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    struct Signed {
        Pay pay;
        Cancel cancel;
    }

    Signed[] internal signed;
    uint64 internal validAfter;
    uint64 internal validBefore;

    ToggleValidation internal toggle;

    function _setUpBrake(bool useToggle) internal {
        _fork();
        payer = vm.addr(payerPk);
        agent = vm.addr(agentPk);
        ERC8004Deploy.Registries memory r = ERC8004Deploy.deploy(address(this));
        identity = IdentityRegistryUpgradeable(r.identity);
        validation = ValidationRegistryUpgradeable(r.validation);
        if (useToggle) toggle = new ToggleValidation();
        IERC8004Validation v = useToggle ? IERC8004Validation(address(toggle)) : IERC8004Validation(address(validation));
        brake = new Brake(TUSD8, IERC8004Identity(address(identity)), v);
        agentId = _registerAgent(payer, payerPk, agentPk);
        vm.prank(payer);
        identity.approve(address(brake), agentId);
        _fund(payer, AMOUNT * 100);
        validAfter = uint64(block.timestamp + 2 days);
        validBefore = uint64(block.timestamp + 4 days);
    }

    function _registerAgent(address owner, uint256, uint256 walletPk) internal returns (uint256 id) {
        vm.prank(owner);
        id = identity.register("ipfs://brake-monitor-agent");
        uint256 deadline = block.timestamp + 4 minutes;
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = identity.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        address wallet = vm.addr(walletPk);
        bytes32 sh = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, id, wallet, owner, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        vm.prank(owner);
        identity.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }

    /// sign n lines (payment + cancel each) and return them as Brake lines
    function _signLines(uint256 n, string memory salt) internal returns (Brake.Line[] memory lines) {
        lines = new Brake.Line[](n);
        delete signed;
        for (uint256 i; i < n; ++i) {
            bytes32 nonce = keccak256(abi.encode(salt, i));
            address payee = makeAddr(string(abi.encodePacked("vendor-", vm.toString(i))));
            Pay memory p = _signPay(payerPk, payee, AMOUNT * (i + 1), validAfter, validBefore, nonce);
            Cancel memory c = _signCancel(payerPk, nonce);
            signed.push(Signed(p, c));
            lines[i] = Brake.Line({payee: payee, amount: p.value, nonce: nonce});
        }
    }

    function _open(uint256 n, uint16 maxStops, uint16 alarmAt) internal returns (Brake.Line[] memory lines) {
        lines = _signLines(n, "monday");
        vm.prank(payer);
        brake.openRun(RUN, agentId, agent, validBefore, maxStops, alarmAt, validAfter, validBefore, lines);
    }

    function _status(uint256 idx) internal view returns (Brake.Status st) {
        (, st) = brake.lineOf(RUN, idx);
    }

    function _agentStop(uint256 idx, bytes32 reason) internal returns (Brake.Status) {
        Cancel memory c = signed[idx].cancel;
        vm.prank(agent);
        return brake.stop(RUN, idx, reason, keccak256(abi.encode("evidence", idx)), "brake://evidence", c.v, c.r, c.s);
    }

    function _agentAllow(uint256 idx) internal {
        uint256[] memory ids = new uint256[](1);
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        ids[0] = idx;
        ev[0] = keccak256(abi.encode("allow", idx));
        uris[0] = "brake://allow";
        vm.prank(agent);
        brake.allow(RUN, ids, ev, uris);
    }
}
