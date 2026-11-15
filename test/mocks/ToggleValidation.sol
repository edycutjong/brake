// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004Validation} from "../../src/interfaces/IERC8004.sol";

/// @notice Minimal stand-in for the ERC-8004 Validation Registry that can be switched to revert — used only to prove a
///         failing receipt never rolls back a stop, and that retryReceipt re-sends it later. The happy path is tested
///         against the vendored reference registry.
contract ToggleValidation is IERC8004Validation {
    struct S {
        address validator;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
    }

    mapping(bytes32 => S) internal s;
    bool public failRequests;
    bool public failResponses;
    uint256 public responses;

    function set(bool requests, bool responses_) external {
        failRequests = requests;
        failResponses = responses_;
    }

    function validationRequest(address validator, uint256 agentId, string calldata, bytes32 rh) external {
        require(!failRequests, "forced request failure");
        require(s[rh].validator == address(0), "exists");
        s[rh].validator = validator;
        s[rh].agentId = agentId;
    }

    function validationResponse(bytes32 rh, uint8 response, string calldata, bytes32 h, string calldata tag) external {
        require(!failResponses, "forced response failure");
        require(msg.sender == s[rh].validator, "not validator");
        s[rh].response = response;
        s[rh].responseHash = h;
        s[rh].tag = tag;
        s[rh].lastUpdate = block.timestamp;
        responses++;
    }

    function getValidationStatus(bytes32 rh)
        external
        view
        returns (address, uint256, uint8, bytes32, string memory, uint256)
    {
        S memory x = s[rh];
        require(x.validator != address(0), "unknown");
        return (x.validator, x.agentId, x.response, x.responseHash, x.tag, x.lastUpdate);
    }
}
