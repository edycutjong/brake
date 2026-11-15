// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BrakeFixture} from "./utils/BrakeFixture.sol";
import {Brake} from "../src/Brake.sol";

/// @notice The safety action never fails because of the receipt: a failing ERC-8004 call is recorded and retried.
contract BrakeReceiptsTest is BrakeFixture {
    event ReceiptFailed(bytes32 indexed runId, uint256 indexed idx);

    function setUp() public {
        _setUpBrake(true);
    }

    function test_failedRequestAtOpen_stopStillCancels_thenRetryRecordsReceipt() public {
        toggle.set(true, false);
        vm.expectEmit(true, true, false, false, address(brake));
        emit ReceiptFailed(RUN, 0);
        _open(2, 2, 2);
        assertFalse(brake.lineDetail(RUN, 0).requested);

        assertEq(uint8(_agentStop(0, "PAYMENT_DETAIL_CHANGE")), uint8(Brake.Status.STOPPED));
        assertTrue(TUSD8.authorizationState(payer, signed[0].pay.nonce), "cancel stands without a receipt");
        assertTrue(brake.lineDetail(RUN, 0).receiptPending);

        toggle.set(false, false);
        vm.prank(stranger); // anyone may retry
        brake.retryReceipt(RUN, 0);
        Brake.LineState memory l = brake.lineDetail(RUN, 0);
        assertFalse(l.receiptPending);
        assertTrue(l.requested);
        (address v,, uint8 resp,, string memory tag,) = toggle.getValidationStatus(brake.requestHashOf(RUN, 0));
        assertEq(v, address(brake));
        assertEq(resp, 0);
        assertEq(tag, "PAYMENT_DETAIL_CHANGE");
    }

    function test_failedResponse_stopStands_retryLater() public {
        _open(2, 2, 2);
        toggle.set(false, true);
        vm.expectEmit(true, true, false, false, address(brake));
        emit ReceiptFailed(RUN, 1);
        _agentStop(1, "SENDER_LOOKALIKE");
        assertEq(uint8(_status(1)), uint8(Brake.Status.STOPPED));
        assertTrue(brake.lineDetail(RUN, 1).receiptPending);

        vm.expectRevert(Brake.NoPendingReceipt.selector);
        brake.retryReceipt(RUN, 0);

        toggle.set(false, false);
        brake.retryReceipt(RUN, 1);
        assertFalse(brake.lineDetail(RUN, 1).receiptPending);
        assertEq(toggle.responses(), 1);
    }

    function test_hold_failingRegistry_holdStands_retryRecordsResponse50() public {
        _open(2, 2, 2);
        toggle.set(false, true);
        vm.prank(agent);
        brake.hold(RUN, 1, "REVIEW_STALE", bytes32(0));
        assertEq(uint8(_status(1)), uint8(Brake.Status.HELD), "the hold never fails because of the receipt");
        assertTrue(brake.lineDetail(RUN, 1).receiptPending);

        toggle.set(false, false);
        brake.retryReceipt(RUN, 1);
        assertFalse(brake.lineDetail(RUN, 1).receiptPending);
        (,, uint8 resp,, string memory tag,) = toggle.getValidationStatus(brake.requestHashOf(RUN, 1));
        assertEq(resp, 50);
        assertEq(tag, "REVIEW_STALE");
    }

    function test_retryWhileStillFailing_staysPending() public {
        _open(1, 2, 2);
        toggle.set(false, true);
        _agentAllow(0);
        brake.retryReceipt(RUN, 0);
        assertTrue(brake.lineDetail(RUN, 0).receiptPending);
        assertEq(uint8(_status(0)), uint8(Brake.Status.ALLOWED));
    }
}
