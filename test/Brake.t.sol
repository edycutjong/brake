// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BrakeFixture} from "./utils/BrakeFixture.sol";
import {Brake} from "../src/Brake.sol";

/// @notice Brake core against live tUSD8 bytecode (Aevum fork) and the vendored ERC-8004 registries.
contract BrakeTest is BrakeFixture {
    event LineStopped(bytes32 indexed runId, uint256 indexed idx, bytes32 reason, bytes32 evidenceHash, address by);
    event StopConsumed(bytes32 indexed runId, uint256 indexed idx);
    event StopAlarm(bytes32 indexed runId, uint16 stops);

    function setUp() public {
        _setUpBrake(false);
    }

    // ------------------------------------------------------------------ openRun + identity binding

    function test_openRun_registersLinesAndOpensValidationRequests() public {
        _open(4, 2, 2);
        Brake.Run memory run = brake.runOf(RUN);
        assertEq(run.payer, payer);
        assertEq(run.agent, agent);
        assertEq(run.lineCount, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(uint8(_status(i)), uint8(Brake.Status.OPEN));
            (address v, uint256 id,,,,) = validation.getValidationStatus(brake.requestHashOf(RUN, i));
            assertEq(v, address(brake), "Brake is the validator");
            assertEq(id, agentId);
        }
    }

    function test_openRun_revertsWhenAgentNotBoundToAgentId() public {
        Brake.Line[] memory lines = _signLines(1, "x");
        vm.prank(payer);
        vm.expectRevert(Brake.AgentNotBound.selector);
        brake.openRun(RUN, agentId, stranger, validBefore, 2, 2, validAfter, validBefore, lines);
    }

    function test_openRun_revertsWhenCallerDoesNotOwnAgentId() public {
        Brake.Line[] memory lines = _signLines(1, "x");
        vm.prank(stranger);
        vm.expectRevert(Brake.AgentNotOwned.selector);
        brake.openRun(RUN, agentId, agent, validBefore, 2, 2, validAfter, validBefore, lines);
    }

    function test_openRun_revertsWithoutSingleTokenApproval() public {
        vm.prank(payer);
        identity.approve(address(0), agentId);
        Brake.Line[] memory lines = _signLines(1, "x");
        vm.prank(payer);
        vm.expectRevert(Brake.BrakeNotApproved.selector);
        brake.openRun(RUN, agentId, agent, validBefore, 2, 2, validAfter, validBefore, lines);
    }

    function test_openRun_rejectsReusedOrDuplicateNonce() public {
        _open(2, 2, 2);
        // the same nonces again in a second run
        Brake.Line[] memory again = _signLines(1, "monday");
        vm.prank(payer);
        vm.expectRevert(Brake.NonceUnavailable.selector);
        brake.openRun(keccak256("run-2"), agentId, agent, validBefore, 2, 2, validAfter, validBefore, again);
    }

    function test_openRun_rejectsBadParameters() public {
        Brake.Line[] memory lines = _signLines(1, "x");
        vm.startPrank(payer);
        vm.expectRevert(Brake.BadRun.selector); // alarmAt > maxStops
        brake.openRun(RUN, agentId, agent, validBefore, 2, 3, validAfter, validBefore, lines);
        vm.expectRevert(Brake.BadRun.selector); // window inverted
        brake.openRun(RUN, agentId, agent, validBefore, 2, 2, validBefore, validAfter, lines);
        vm.expectRevert(Brake.BadRun.selector); // no lines
        brake.openRun(RUN, agentId, agent, validBefore, 2, 2, validAfter, validBefore, new Brake.Line[](0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ allow / hold transitions

    function test_agentAllow_openToAllowed_andReaffirm_withReceipt() public {
        _open(2, 2, 2);
        _agentAllow(0);
        assertEq(uint8(_status(0)), uint8(Brake.Status.ALLOWED));
        _agentAllow(0); // re-affirm on a new evidence revision
        assertEq(uint8(_status(0)), uint8(Brake.Status.ALLOWED));
        (,, uint8 resp,, string memory tag,) = validation.getValidationStatus(brake.requestHashOf(RUN, 0));
        assertEq(resp, 100);
        assertEq(tag, "ALLOW");
    }

    function test_hold_blocksAgentAllow_payerReleasesWithFinanceAllow() public {
        _open(2, 2, 2);
        vm.prank(agent);
        brake.hold(RUN, 1, "INJECTION_FLAGGED", keccak256("inj"));
        assertEq(uint8(_status(1)), uint8(Brake.Status.HELD));

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Brake.BadTransition.selector, Brake.Status.HELD));
        brake.allow(RUN, ids, ev, uris);

        vm.prank(payer);
        brake.allow(RUN, ids, ev, uris);
        assertEq(uint8(_status(1)), uint8(Brake.Status.ALLOWED));
        (,,,, string memory tag,) = validation.getValidationStatus(brake.requestHashOf(RUN, 1));
        assertEq(tag, "FINANCE_ALLOW");
    }

    function test_payerAllow_cannotReopenAnAllowedLine_andHoldRejectsUnknownReason() public {
        _open(1, 2, 2);
        _agentAllow(0);
        uint256[] memory ids = new uint256[](1);
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Brake.BadTransition.selector, Brake.Status.ALLOWED));
        brake.allow(RUN, ids, ev, uris);
        vm.prank(agent);
        vm.expectRevert(Brake.UnknownReason.selector);
        brake.hold(RUN, 0, "I_FEEL_LIKE_IT", bytes32(0));
    }

    // ------------------------------------------------------------------ stop

    function test_stop_cancelsOnTokenRecordsReasonAndReceipt_thenPaymentReverts() public {
        _open(4, 2, 2);
        _agentAllow(2); // Monday: nothing suspicious on file
        vm.expectEmit(true, true, false, true, address(brake));
        emit LineStopped(RUN, 2, "PAYMENT_DETAIL_CHANGE", keccak256(abi.encode("evidence", uint256(2))), agent);
        Brake.Status st = _agentStop(2, "PAYMENT_DETAIL_CHANGE");
        assertEq(uint8(st), uint8(Brake.Status.STOPPED));
        assertTrue(TUSD8.authorizationState(payer, signed[2].pay.nonce), "token-level cancel");
        (,, uint8 resp,, string memory tag,) = validation.getValidationStatus(brake.requestHashOf(RUN, 2));
        assertEq(resp, 0);
        assertEq(tag, "PAYMENT_DETAIL_CHANGE");
        assertEq(brake.runOf(RUN).stops, 1);

        // payday: the keeper's payment for the stopped line reverts with the token's own error
        vm.warp(validAfter + 1);
        vm.prank(keeper);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _pay(signed[2].pay);
        // an allowed line still pays
        vm.prank(keeper);
        _pay(signed[0].pay);
        assertEq(TUSD8.balanceOf(signed[0].pay.to), signed[0].pay.value);
    }

    function test_stop_isIdempotent_noSecondBudgetCharge() public {
        _open(4, 2, 2);
        _agentStop(1, "INVOICE_DISPUTED");
        Brake.Status again = _agentStop(1, "INVOICE_DISPUTED");
        assertEq(uint8(again), uint8(Brake.Status.STOPPED));
        assertEq(brake.runOf(RUN).stops, 1);
    }

    function test_stop_marksConsumedWhenNonceUsedOutsideBrake() public {
        _open(2, 2, 2);
        // the payer cancels the nonce directly at the token, outside Brake
        Cancel memory c = signed[0].cancel;
        TUSD8.cancelAuthorization(payer, signed[0].pay.nonce, c.v, c.r, c.s);
        vm.expectEmit(true, true, false, false, address(brake));
        emit StopConsumed(RUN, 0);
        Brake.Status st = _agentStop(0, "BANK_CHANGE_UNVERIFIED");
        assertEq(uint8(st), uint8(Brake.Status.CONSUMED));
        assertEq(brake.runOf(RUN).stops, 0, "no budget for a consumed nonce");
        assertEq(uint8(_agentStop(0, "BANK_CHANGE_UNVERIFIED")), uint8(Brake.Status.CONSUMED), "idempotent");
    }

    function test_stop_tooLate_afterPaymentIsConsumed() public {
        _open(2, 2, 2);
        vm.warp(validAfter + 1);
        vm.prank(keeper);
        _pay(signed[1].pay);
        assertEq(uint8(_agentStop(1, "INVOICE_DISPUTED")), uint8(Brake.Status.CONSUMED));
    }

    function test_stopBudget_alarmAtLimit_thenExhausted() public {
        _open(4, 2, 2);
        _agentStop(0, "INVOICE_DISPUTED");
        vm.expectEmit(true, false, false, true, address(brake));
        emit StopAlarm(RUN, 2);
        _agentStop(1, "DUPLICATE_INVOICE");
        Cancel memory c = signed[2].cancel;
        vm.prank(agent);
        vm.expectRevert(Brake.StopBudgetExhausted.selector);
        brake.stop(RUN, 2, "AMOUNT_MISMATCH", bytes32(0), "", c.v, c.r, c.s);
        // past the budget the agent holds the line for finance instead
        vm.prank(agent);
        brake.hold(RUN, 2, "BUDGET_EXHAUSTED", bytes32(0));
        assertEq(uint8(_status(2)), uint8(Brake.Status.HELD));
    }

    function test_stop_fromHeld_andAllowedAfterStopReverts() public {
        _open(2, 2, 2);
        vm.prank(agent);
        brake.hold(RUN, 0, "REVIEW_STALE", bytes32(0));
        assertEq(uint8(_agentStop(0, "SENDER_LOOKALIKE")), uint8(Brake.Status.STOPPED));
        uint256[] memory ids = new uint256[](1);
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Brake.BadTransition.selector, Brake.Status.STOPPED));
        brake.allow(RUN, ids, ev, uris);
    }

    function test_stop_rejectsHoldOnlyReasonAndBadSignature() public {
        _open(2, 2, 2);
        Cancel memory c = signed[0].cancel;
        vm.prank(agent);
        vm.expectRevert(Brake.UnknownReason.selector);
        brake.stop(RUN, 0, "INJECTION_FLAGGED", bytes32(0), "", c.v, c.r, c.s);
        // line 1's cancel signature does not match line 0's nonce: token rejects, nothing changes
        Cancel memory wrong = signed[1].cancel;
        vm.prank(agent);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        brake.stop(RUN, 0, "INVOICE_DISPUTED", bytes32(0), "", wrong.v, wrong.r, wrong.s);
        assertEq(uint8(_status(0)), uint8(Brake.Status.OPEN));
        assertEq(brake.runOf(RUN).stops, 0);
    }

    // ------------------------------------------------------------------ grant

    function test_grant_strangerRevokedAndExpiredAgentsCannotAct() public {
        _open(2, 2, 2);
        Cancel memory c = signed[0].cancel;
        vm.prank(stranger);
        vm.expectRevert(Brake.NotAgent.selector);
        brake.stop(RUN, 0, "INVOICE_DISPUTED", bytes32(0), "", c.v, c.r, c.s);

        vm.warp(validBefore + 1);
        vm.prank(agent);
        vm.expectRevert(Brake.AgentExpired.selector);
        brake.stop(RUN, 0, "INVOICE_DISPUTED", bytes32(0), "", c.v, c.r, c.s);

        vm.warp(validAfter);
        vm.prank(payer);
        brake.revokeAgent(RUN);
        vm.prank(agent);
        vm.expectRevert(Brake.GrantRevoked.selector);
        brake.stop(RUN, 0, "INVOICE_DISPUTED", bytes32(0), "", c.v, c.r, c.s);
        vm.prank(stranger);
        vm.expectRevert(Brake.NotPayer.selector);
        brake.revokeAgent(RUN);
    }

    function test_agentHoldsNoSpendingPower_brakeNeverHoldsFunds() public {
        _open(4, 2, 2);
        _agentAllow(0);
        _agentStop(1, "INVOICE_DISPUTED");
        vm.prank(agent);
        brake.hold(RUN, 2, "INJECTION_FLAGGED", bytes32(0));
        assertEq(TUSD8.balanceOf(address(brake)), 0);
        assertEq(TUSD8.balanceOf(agent), 0);
        assertEq(TUSD8.balanceOf(payer), AMOUNT * 100, "no agent action moved the payer's funds");
    }

    function test_unknownRunAndLineRevert() public {
        vm.prank(agent);
        vm.expectRevert(Brake.UnknownLine.selector);
        brake.hold(keccak256("nope"), 0, "REVIEW_STALE", bytes32(0));
        _open(1, 2, 2);
        vm.expectRevert(Brake.UnknownLine.selector);
        brake.lineOf(RUN, 5);
    }

    function test_financeStop_noBudget_sameReceipt() public {
        _open(2, 1, 1);
        Cancel memory c = signed[0].cancel;
        vm.prank(payer);
        brake.financeStop(RUN, 0, "GOODS_NOT_RECEIVED", keccak256("pod"), "brake://pod", c.v, c.r, c.s);
        assertEq(uint8(_status(0)), uint8(Brake.Status.STOPPED));
        assertEq(brake.runOf(RUN).stops, 0);
        (,, uint8 resp,, string memory tag,) = validation.getValidationStatus(brake.requestHashOf(RUN, 0));
        assertEq(resp, 0);
        assertEq(tag, "GOODS_NOT_RECEIVED");
    }

    function test_stop_idempotentRetryAfterRevokeReturnsTerminalStatus() public {
        _open(2, 2, 2);
        _agentStop(0, "INVOICE_DISPUTED");
        vm.prank(payer);
        brake.revokeAgent(RUN);
        assertEq(uint8(_agentStop(0, "INVOICE_DISPUTED")), uint8(Brake.Status.STOPPED));
        // but a fresh stop on an open line is refused
        Cancel memory c = signed[1].cancel;
        vm.prank(agent);
        vm.expectRevert(Brake.GrantRevoked.selector);
        brake.stop(RUN, 1, "INVOICE_DISPUTED", bytes32(0), "", c.v, c.r, c.s);
    }
}
