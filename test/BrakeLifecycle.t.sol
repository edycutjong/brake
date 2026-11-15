// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BrakeFixture} from "./utils/BrakeFixture.sol";
import {Brake} from "../src/Brake.sol";
import {IERC8004Identity, IERC8004Validation} from "../src/interfaces/IERC8004.sol";
import {ReentrantValidation} from "./mocks/ReentrantValidation.sol";

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory);
}

/// @notice G2b (Brake's ERC-8004 lifecycle on the reference registry), re-issue, the payday race, and re-entrancy.
contract BrakeLifecycleTest is BrakeFixture {
    event LineReissued(bytes32 indexed runId, uint256 oldIdx, uint256 newIdx);

    function setUp() public {
        _setUpBrake(false);
    }

    // ------------------------------------------------------------------------------------------------ G2b lifecycle

    function test_g2b_openRunOpensOneRequestPerLine_brakeIsValidator() public {
        _open(4, 2, 2);
        bytes32[] memory forAgent = validation.getAgentValidations(agentId);
        bytes32[] memory forBrake = validation.getValidatorRequests(address(brake));
        assertEq(forAgent.length, 4);
        assertEq(forBrake.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(forAgent[i], brake.requestHashOf(RUN, i));
            (address v, uint256 id,,,,) = validation.getValidationStatus(forAgent[i]);
            assertEq(v, address(brake));
            assertEq(id, agentId);
        }
    }

    function test_g2b_allowThenStopOnOneLine_responseOverwrites_summaryCounts() public {
        _open(4, 2, 2);
        for (uint256 i; i < 4; ++i) {
            _agentAllow(i);
        }
        bytes32 rh = brake.requestHashOf(RUN, 2);
        (,, uint8 resp,, string memory tag,) = validation.getValidationStatus(rh);
        assertEq(resp, 100);
        assertEq(tag, "ALLOW");

        _agentStop(2, "PAYMENT_DETAIL_CHANGE");
        bytes32 ev;
        (,, resp, ev, tag,) = validation.getValidationStatus(rh);
        assertEq(resp, 0, "STOP overwrites ALLOW");
        assertEq(tag, "PAYMENT_DETAIL_CHANGE");
        assertEq(ev, keccak256(abi.encode("evidence", uint256(2))), "evidence hash is the response hash");

        address[] memory validators = new address[](1);
        validators[0] = address(brake);
        (uint64 allowCount, uint8 allowAvg) = validation.getSummary(agentId, validators, "ALLOW");
        (uint64 stopCount,) = validation.getSummary(agentId, validators, "PAYMENT_DETAIL_CHANGE");
        assertEq(allowCount, 3);
        assertEq(allowAvg, 100);
        assertEq(stopCount, 1);
    }

    function test_g2b_financeAllowAfterHold_tagsFinanceAllow() public {
        _open(2, 2, 2);
        vm.prank(agent);
        brake.hold(RUN, 1, "INJECTION_FLAGGED", bytes32(0));
        uint256[] memory ids = new uint256[](1);
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        ids[0] = 1;
        vm.prank(payer);
        brake.allow(RUN, ids, ev, uris);
        (,, uint8 resp,, string memory tag,) = validation.getValidationStatus(brake.requestHashOf(RUN, 1));
        assertEq(resp, 100);
        assertEq(tag, "FINANCE_ALLOW");
    }

    function test_g2b_revokedApprovalAtOpen_isRejectedBeforeAnyState() public {
        vm.prank(payer);
        identity.approve(address(0), agentId);
        Brake.Line[] memory lines = _signLines(2, "monday");
        vm.prank(payer);
        vm.expectRevert(Brake.BrakeNotApproved.selector);
        brake.openRun(RUN, agentId, agent, validBefore, 2, 2, validAfter, validBefore, lines);
        assertFalse(brake.nonceRegistered(payer, lines[0].nonce));
    }

    // ---------------------------------------------------------------------------------------------------- reissue

    function _freshLine(string memory salt, uint64 va, uint64 vb) internal returns (Brake.Line memory l, Pay memory p) {
        bytes32 nonce = keccak256(abi.encode("reissue", salt));
        address payee = makeAddr("vendor-2-verified");
        p = _signPay(payerPk, payee, AMOUNT * 3, va, vb, nonce);
        l = Brake.Line({payee: payee, amount: p.value, nonce: nonce});
    }

    function test_reissue_stoppedLineToVerifiedPayee_thenPaysOnPayday() public {
        _open(4, 2, 2);
        _agentStop(2, "PAYMENT_DETAIL_CHANGE");
        (Brake.Line memory fresh, Pay memory p) = _freshLine("a", validAfter, validBefore);
        vm.expectEmit(true, false, false, true, address(brake));
        emit LineReissued(RUN, 2, 4);
        vm.prank(payer);
        uint256 newIdx = brake.reissue(RUN, 2, fresh, validAfter, validBefore);
        assertEq(newIdx, 4);
        assertEq(uint8(_status(2)), uint8(Brake.Status.REISSUED));
        assertEq(uint8(_status(4)), uint8(Brake.Status.OPEN));
        assertEq(brake.runOf(RUN).lineCount, 5);
        // the new line has its own validation request
        (address v,,,,,) = validation.getValidationStatus(brake.requestHashOf(RUN, 4));
        assertEq(v, address(brake));

        uint256[] memory ids = new uint256[](1);
        bytes32[] memory ev = new bytes32[](1);
        string[] memory uris = new string[](1);
        ids[0] = 4;
        vm.prank(payer);
        brake.allow(RUN, ids, ev, uris);

        vm.warp(validAfter + 1);
        uint256 before = TUSD8.balanceOf(fresh.payee);
        vm.prank(keeper);
        _pay(p);
        assertEq(TUSD8.balanceOf(fresh.payee) - before, fresh.amount);
        // the original line stays dead: its payment still reverts at the token
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _pay(signed[2].pay);
    }

    function test_reissue_afterOriginalExpiry_agentStillMonitorsTheFreshLine() public {
        _open(2, 2, 2);
        _agentStop(1, "BANK_CHANGE_UNVERIFIED");
        // dispute settles after the original window closed
        vm.warp(validBefore + 1 days);
        uint64 va = uint64(block.timestamp + 1 days);
        uint64 vb = uint64(block.timestamp + 3 days);
        (Brake.Line memory fresh,) = _freshLine("late", va, vb);
        vm.prank(payer);
        uint256 newIdx = brake.reissue(RUN, 1, fresh, va, vb);
        assertEq(brake.lineDetail(RUN, newIdx).agentExpiry, vb, "fresh line carries its own agent expiry");
        _agentAllow(newIdx); // would revert AgentExpired if the original grant applied
        assertEq(uint8(_status(newIdx)), uint8(Brake.Status.ALLOWED));
        // the original lines are past their grant
        vm.prank(agent);
        vm.expectRevert(Brake.AgentExpired.selector);
        brake.hold(RUN, 0, "REVIEW_STALE", bytes32(0));
    }

    function test_reissue_onlyPayer_onlyFromStopped_freshNonceRequired() public {
        _open(3, 2, 2);
        (Brake.Line memory fresh,) = _freshLine("b", validAfter, validBefore);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Brake.BadTransition.selector, Brake.Status.OPEN));
        brake.reissue(RUN, 0, fresh, validAfter, validBefore);

        _agentStop(0, "INVOICE_DISPUTED");
        vm.prank(agent);
        vm.expectRevert(Brake.NotPayer.selector);
        brake.reissue(RUN, 0, fresh, validAfter, validBefore);

        // reusing the stopped line's own (cancelled) nonce is refused
        Brake.Line memory reused = Brake.Line({payee: fresh.payee, amount: fresh.amount, nonce: signed[0].pay.nonce});
        vm.prank(payer);
        vm.expectRevert(Brake.NonceUnavailable.selector);
        brake.reissue(RUN, 0, reused, validAfter, validBefore);

        vm.prank(payer);
        brake.reissue(RUN, 0, fresh, validAfter, validBefore);
        // a second reissue of the same line is refused, and a stop on it returns REISSUED idempotently
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Brake.BadTransition.selector, Brake.Status.REISSUED));
        brake.reissue(RUN, 0, fresh, validAfter, validBefore);
        assertEq(uint8(_agentStop(0, "INVOICE_DISPUTED")), uint8(Brake.Status.REISSUED));
        assertEq(brake.runOf(RUN).stops, 1, "no second budget charge");
    }

    // ------------------------------------------------------------------------------------------------ payday race

    function _payCalls(uint256 n) internal view returns (IMulticall3.Call3[] memory calls) {
        calls = new IMulticall3.Call3[](n);
        for (uint256 i; i < n; ++i) {
            Pay memory p = signed[i].pay;
            calls[i] = IMulticall3.Call3({
                target: address(TUSD8),
                allowFailure: true,
                callData: abi.encodeWithSignature(
                    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                    p.from,
                    p.to,
                    p.value,
                    p.validAfter,
                    p.validBefore,
                    p.nonce,
                    p.v,
                    p.r,
                    p.s
                )
            });
        }
    }

    function test_payday_multicall3_paysThreeAndStoppedLineReverts() public {
        _open(4, 2, 2);
        for (uint256 i; i < 4; ++i) {
            _agentAllow(i);
        }
        _agentStop(2, "PAYMENT_DETAIL_CHANGE");
        vm.warp(validAfter + 1);
        vm.prank(keeper);
        IMulticall3.Result[] memory res = IMulticall3(MULTICALL3).aggregate3(_payCalls(4));
        assertTrue(res[0].success && res[1].success && res[3].success);
        assertFalse(res[2].success, "stopped line reverts inside the batch");
        assertEq(TUSD8.balanceOf(signed[2].pay.to), 0);
        assertEq(TUSD8.balanceOf(signed[3].pay.to), signed[3].pay.value);
    }

    function test_race_paymentLandsFirst_thenStopIsTooLate_noBudgetCharged() public {
        _open(2, 2, 2);
        vm.warp(validAfter + 1);
        vm.prank(keeper);
        IMulticall3(MULTICALL3).aggregate3(_payCalls(2));
        assertEq(uint8(_agentStop(0, "INVOICE_DISPUTED")), uint8(Brake.Status.CONSUMED));
        assertEq(brake.runOf(RUN).stops, 0, "TOO_LATE costs no budget");
        // second call is idempotent
        assertEq(uint8(_agentStop(0, "INVOICE_DISPUTED")), uint8(Brake.Status.CONSUMED));
    }

    function test_race_payerCancelsAtTokenDirectly_lineBecomesConsumed() public {
        _open(2, 2, 2);
        Cancel memory c = signed[1].cancel;
        TUSD8.cancelAuthorization(payer, signed[1].pay.nonce, c.v, c.r, c.s); // outside Brake
        assertEq(uint8(_agentStop(1, "INVOICE_DISPUTED")), uint8(Brake.Status.CONSUMED));
    }

    function test_holdBindsKeeperOnly_paymentStillValidAtToken() public {
        // documents the I5 boundary: a hold is a keeper-side instruction, not a token-level block
        _open(2, 2, 2);
        vm.prank(agent);
        brake.hold(RUN, 0, "INJECTION_FLAGGED", bytes32(0));
        vm.warp(validAfter + 1);
        _pay(signed[0].pay);
        assertEq(TUSD8.balanceOf(signed[0].pay.to), signed[0].pay.value);
    }

    // --------------------------------------------------------------------------------------------------- reentrancy

    function test_reentrancy_hostileRegistryCannotReenterDuringReceipt() public {
        ReentrantValidation hostile = new ReentrantValidation();
        brake = new Brake(TUSD8, IERC8004Identity(address(identity)), IERC8004Validation(address(hostile)));
        vm.prank(payer);
        identity.approve(address(brake), agentId);
        _open(2, 3, 3);

        Cancel memory c = signed[1].cancel;
        hostile.arm(
            address(brake),
            abi.encodeCall(Brake.stop, (RUN, 1, bytes32("INVOICE_DISPUTED"), bytes32(0), "", c.v, c.r, c.s))
        );
        _agentStop(0, "INVOICE_DISPUTED");
        assertTrue(hostile.attempted());
        assertFalse(hostile.reentryOk(), "re-entry blocked");
        assertEq(bytes4(hostile.reentryError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(brake.runOf(RUN).stops, 1);
        assertEq(uint8(_status(1)), uint8(Brake.Status.OPEN));
        assertFalse(brake.lineDetail(RUN, 0).receiptPending, "the outer receipt still completes");
    }
}
