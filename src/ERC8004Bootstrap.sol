// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice First implementation behind each ERC-8004 registry proxy. It sets the owner (initializer v1) so the owner
///         can immediately `upgradeToAndCall` the real registry and run its `reinitializer(2) onlyOwner` initialize.
///         Slot 0 holds the identity-registry address, as the reference ValidationRegistry expects.
contract ERC8004Bootstrap is OwnableUpgradeable, UUPSUpgradeable {
    address private _identityRegistry;

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address identityRegistry_) public initializer {
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        _identityRegistry = identityRegistry_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
