// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC8004Bootstrap} from "../src/ERC8004Bootstrap.sol";
import {IdentityRegistryUpgradeable} from "../src/vendor/erc8004/IdentityRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "../src/vendor/erc8004/ValidationRegistryUpgradeable.sol";
import {Brake} from "../src/Brake.sol";
import {IEIP3009} from "../src/interfaces/IEIP3009.sol";
import {IERC8004Identity, IERC8004Validation} from "../src/interfaces/IERC8004.sol";

/// @notice Deterministic deploy on Aevum testnet through the Arachnid CREATE2 deployer
///         (0x4e59b44847b379578588920cA78FbF26c0B4956C, live on 44005), then the demo payer registers the monitor
///         agent's ERC-8004 identity, binds the agent wallet (signed by the agent key) and approves Brake for it.
/// env: DEPLOYER_PRIVATE_KEY, DEMO_PAYER_PRIVATE_KEY, AGENT_PRIVATE_KEY, DEPLOY_MODE ("live" | "fork")
contract Deploy is Script {
    IEIP3009 internal constant TUSD8 = IEIP3009(0x456569838f1d43009A91ebA4263147Afd7233483);
    bytes32 internal constant SALT = keccak256("brake.v1");
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 payerPk = vm.envUint("DEMO_PAYER_PRIVATE_KEY");
        uint256 agentPk = vm.envUint("AGENT_PRIVATE_KEY");
        string memory mode = vm.envOr("DEPLOY_MODE", string("fork"));
        address deployer = vm.addr(deployerPk);
        address payer = vm.addr(payerPk);
        address agent = vm.addr(agentPk);
        require(block.chainid == 44005, "Aevum testnet only");

        vm.startBroadcast(deployerPk);
        address bootstrapImpl = address(new ERC8004Bootstrap{salt: SALT}());
        address identityImpl = address(new IdentityRegistryUpgradeable{salt: SALT}());
        address validationImpl = address(new ValidationRegistryUpgradeable{salt: SALT}());
        address identity = address(
            new ERC1967Proxy{salt: keccak256("brake.v1.identity")}(
                bootstrapImpl, abi.encodeCall(ERC8004Bootstrap.initialize, (deployer, address(0)))
            )
        );
        UUPSUpgradeable(identity).upgradeToAndCall(identityImpl, abi.encodeCall(IdentityRegistryUpgradeable.initialize, ()));
        address validation = address(
            new ERC1967Proxy{salt: keccak256("brake.v1.validation")}(
                bootstrapImpl, abi.encodeCall(ERC8004Bootstrap.initialize, (deployer, identity))
            )
        );
        UUPSUpgradeable(validation).upgradeToAndCall(
            validationImpl, abi.encodeCall(ValidationRegistryUpgradeable.initialize, (identity))
        );
        Brake brake = new Brake{salt: SALT}(TUSD8, IERC8004Identity(identity), IERC8004Validation(validation));
        vm.stopBroadcast();

        // the demo payer owns the monitor agent's identity and binds the agent wallet to it
        vm.startBroadcast(payerPk);
        uint256 agentId = IdentityRegistryUpgradeable(identity).register("https://github.com/edycutjong/brake#agent");
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory sig = _agentWalletSig(IdentityRegistryUpgradeable(identity), agentPk, agentId, agent, payer, deadline);
        IdentityRegistryUpgradeable(identity).setAgentWallet(agentId, agent, deadline, sig);
        IdentityRegistryUpgradeable(identity).approve(address(brake), agentId);
        vm.stopBroadcast();

        require(IdentityRegistryUpgradeable(identity).getAgentWallet(agentId) == agent, "binding");
        require(IdentityRegistryUpgradeable(identity).getApproved(agentId) == address(brake), "approval");

        string memory k = "deploy";
        vm.serializeString(k, "mode", mode);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "block", block.number);
        vm.serializeAddress(k, "create2Deployer", CREATE2_FACTORY);
        vm.serializeAddress(k, "token", address(TUSD8));
        vm.serializeAddress(k, "brake", address(brake));
        vm.serializeAddress(k, "identityRegistry", identity);
        vm.serializeAddress(k, "validationRegistry", validation);
        vm.serializeAddress(k, "identityImpl", identityImpl);
        vm.serializeAddress(k, "validationImpl", validationImpl);
        vm.serializeAddress(k, "bootstrapImpl", bootstrapImpl);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "payer", payer);
        vm.serializeAddress(k, "agent", agent);
        string memory json = vm.serializeUint(k, "agentId", agentId);
        vm.writeJson(json, string.concat("./evidence/deploy-44005-", mode, ".json"));
        console2.log("Brake", address(brake));
        console2.log("IdentityRegistry", identity);
        console2.log("ValidationRegistry", validation);
        console2.log("agentId", agentId);
    }

    function _agentWalletSig(
        IdentityRegistryUpgradeable identity,
        uint256 agentPk,
        uint256 agentId,
        address agent,
        address owner,
        uint256 deadline
    ) internal view returns (bytes memory) {
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
        bytes32 sh = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, agent, owner, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, s, v);
    }
}
