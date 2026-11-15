// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEIP3009} from "../interfaces/IEIP3009.sol";

/// @notice G1 kill test: submits a payer's pre-signed cancelAuthorization from a contract, the way Brake will.
contract CancelRelay {
    function cancel(IEIP3009 token, address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        token.cancelAuthorization(authorizer, nonce, v, r, s);
    }
}
