// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC8004Bootstrap} from "../../src/ERC8004Bootstrap.sol";
import {IdentityRegistryUpgradeable} from "../../src/vendor/erc8004/IdentityRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "../../src/vendor/erc8004/ValidationRegistryUpgradeable.sol";

/// @notice Deploys the vendored ERC-8004 reference registries behind ERC1967 proxies.
///         `owner` must be the account that executes these calls (the test contract, or the broadcaster in a script).
library ERC8004Deploy {
    struct Registries {
        address identity;
        address validation;
        address bootstrapImpl;
        address identityImpl;
        address validationImpl;
    }

    function deploy(address owner) internal returns (Registries memory r) {
        r.bootstrapImpl = address(new ERC8004Bootstrap());
        r.identityImpl = address(new IdentityRegistryUpgradeable());
        r.validationImpl = address(new ValidationRegistryUpgradeable());

        r.identity = address(
            new ERC1967Proxy(r.bootstrapImpl, abi.encodeCall(ERC8004Bootstrap.initialize, (owner, address(0))))
        );
        UUPSUpgradeable(r.identity)
            .upgradeToAndCall(r.identityImpl, abi.encodeCall(IdentityRegistryUpgradeable.initialize, ()));

        r.validation = address(
            new ERC1967Proxy(r.bootstrapImpl, abi.encodeCall(ERC8004Bootstrap.initialize, (owner, r.identity)))
        );
        UUPSUpgradeable(r.validation)
            .upgradeToAndCall(r.validationImpl, abi.encodeCall(ValidationRegistryUpgradeable.initialize, (r.identity)));
    }
}
