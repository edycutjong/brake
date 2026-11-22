// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004Validation} from "../../src/interfaces/IERC8004.sol";

/// @notice Hostile Validation Registry: during validationResponse it calls back into Brake with arbitrary calldata and
///         records whether that re-entry succeeded. Used only to prove Brake's nonReentrant guard holds on the receipt path.
contract ReentrantValidation is IERC8004Validation {
    address public target;
    bytes public payload;
    bool public attempted;
    bool public reentryOk;
    bytes public reentryError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function validationRequest(address, uint256, string calldata, bytes32) external {}

    function validationResponse(bytes32, uint8, string calldata, bytes32, string calldata) external {
        if (target == address(0) || attempted) return;
        attempted = true;
        (reentryOk, reentryError) = target.call(payload);
    }

    function getValidationStatus(bytes32)
        external
        pure
        returns (address, uint256, uint8, bytes32, string memory, uint256)
    {
        return (address(0), 0, 0, bytes32(0), "", 0);
    }
}
