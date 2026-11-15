// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AevumFork} from "./utils/AevumFork.sol";
import {ERC8004Deploy} from "../script/lib/ERC8004Deploy.sol";
import {IdentityRegistryUpgradeable} from "../src/vendor/erc8004/IdentityRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "../src/vendor/erc8004/ValidationRegistryUpgradeable.sol";

/// @notice G2a: the pinned ERC-8004 reference registries on an Aevum fork answer the three questions Brake's design
///         depends on — (1) a second response per requestHash, (2) an agent-address binding, (3) single-token approve.
contract G2aERC8004Test is AevumFork {
    IdentityRegistryUpgradeable internal identity;
    ValidationRegistryUpgradeable internal validation;

    address internal payer = makeAddr("payer");
    uint256 internal agentPk = uint256(keccak256("brake.g2a.agent"));
    address internal agent;
    address internal validator = makeAddr("validator-standin-for-Brake");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    function setUp() public {
        _fork();
        ERC8004Deploy.Registries memory r = ERC8004Deploy.deploy(address(this));
        identity = IdentityRegistryUpgradeable(r.identity);
        validation = ValidationRegistryUpgradeable(r.validation);
        agent = vm.addr(agentPk);
    }

    function _register() internal returns (uint256 agentId) {
        vm.prank(payer);
        agentId = identity.register("ipfs://brake-agent-card");
    }

    function _walletSig(uint256 agentId, uint256 deadline) internal view returns (bytes memory) {
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
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, agent, payer, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_deployedAndInitialised() public view {
        assertEq(identity.getVersion(), "2.0.0");
        assertEq(validation.getIdentityRegistry(), address(identity));
        assertEq(identity.owner(), address(this));
    }

    /// Q2: an agent-address binding exists — setAgentWallet, signed once by the agent key.
    function test_q2_agentWalletBindingNeedsAgentSignature() public {
        uint256 agentId = _register();
        assertEq(identity.ownerOf(agentId), payer);
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory sig = _walletSig(agentId, deadline);
        vm.prank(payer);
        identity.setAgentWallet(agentId, agent, deadline, sig);
        assertEq(identity.getAgentWallet(agentId), agent);

        // the owner alone cannot bind an address that did not sign
        vm.prank(payer);
        vm.expectRevert(bytes("invalid wallet sig"));
        identity.setAgentWallet(agentId, stranger, deadline, sig);
    }

    /// Q3: a single-token approve (getApproved) lets Brake open validation requests for that one agentId.
    function test_q3_singleTokenApproveIsHonoured() public {
        uint256 agentId = _register();
        bytes32 rh = keccak256("line-0");
        vm.prank(validator);
        vm.expectRevert(bytes("Not authorized"));
        validation.validationRequest(validator, agentId, "brake://run/0", rh);

        vm.prank(payer);
        identity.approve(validator, agentId);
        assertFalse(identity.isApprovedForAll(payer, validator));
        vm.prank(validator);
        validation.validationRequest(validator, agentId, "brake://run/0", rh);
        (address v,,,,,) = validation.getValidationStatus(rh);
        assertEq(v, validator);
    }

    /// Q1: a second response on the same requestHash is accepted and overwrites the first (events keep history).
    function test_q1_secondResponseOverwrites() public {
        uint256 agentId = _register();
        vm.prank(payer);
        identity.approve(validator, agentId);
        bytes32 rh = keccak256("line-3");
        vm.startPrank(validator);
        validation.validationRequest(validator, agentId, "brake://run/3", rh);
        validation.validationResponse(rh, 100, "brake://allow", keccak256("monday"), "ALLOW");
        validation.validationResponse(rh, 0, "brake://stop", keccak256("tuesday"), "PAYMENT_DETAIL_CHANGE");
        vm.stopPrank();
        (,, uint8 resp, bytes32 respHash, string memory tag,) = validation.getValidationStatus(rh);
        assertEq(resp, 0);
        assertEq(respHash, keccak256("tuesday"));
        assertEq(tag, "PAYMENT_DETAIL_CHANGE");
    }

    function test_duplicateRequestHashRejected_andOnlyValidatorResponds() public {
        uint256 agentId = _register();
        vm.prank(payer);
        identity.approve(validator, agentId);
        bytes32 rh = keccak256("dup");
        vm.prank(validator);
        validation.validationRequest(validator, agentId, "", rh);
        vm.prank(validator);
        vm.expectRevert(bytes("exists"));
        validation.validationRequest(validator, agentId, "", rh);
        vm.prank(stranger);
        vm.expectRevert(bytes("not validator"));
        validation.validationResponse(rh, 0, "", bytes32(0), "");
    }

    function test_transferClearsAgentWallet() public {
        uint256 agentId = _register();
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory sig = _walletSig(agentId, deadline);
        vm.prank(payer);
        identity.setAgentWallet(agentId, agent, deadline, sig);
        vm.prank(payer);
        identity.transferFrom(payer, stranger, agentId);
        assertEq(identity.getAgentWallet(agentId), address(0));
    }
}
