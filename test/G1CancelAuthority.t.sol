// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AevumFork, IEIP3009} from "./utils/AevumFork.sol";
import {CancelRelay} from "../src/test-helpers/CancelRelay.sol";

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

/// @notice G1 kill test replicated against live tUSD8 bytecode: anyone may submit the payer's pre-signed cancel.
contract G1CancelAuthorityTest is AevumFork {
    uint256 internal pkA = uint256(keccak256("brake.g1.payer"));
    address internal A;
    address internal B = makeAddr("unrelated-caller");
    address internal payee = makeAddr("payee");
    uint256 internal constant VALUE = 10_000; // 0.01 tUSD8

    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function setUp() public {
        _fork();
        A = vm.addr(pkA);
        _fund(A, VALUE * 10);
    }

    function test_step0_domainMatchesNameAndVersion() public view {
        bytes32 rebuilt = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(TUSD8.name())),
                keccak256(bytes(TUSD8.version())),
                block.chainid,
                address(TUSD8)
            )
        );
        assertEq(rebuilt, TUSD8.DOMAIN_SEPARATOR());
        assertEq(TUSD8.name(), "tUSD8");
        assertEq(TUSD8.version(), "2");
        bytes32 implWord = vm.load(address(TUSD8), 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3);
        address impl = address(uint160(uint256(implWord)));
        assertEq(impl, 0xD6bE708F41b07b2F4A7B48889b8e16626e317597);
        assertEq(impl.codehash, 0x4502bbaa17e9d02985ef04ecf150b2d1ff330b907efd9f312e76ca2743ec5dc2);
    }

    function test_step1_unrelatedEoaCanSubmitCancel() public {
        bytes32 nonce = keccak256("g1-step1");
        Cancel memory c = _signCancel(pkA, nonce);
        vm.expectEmit(true, true, false, false, address(TUSD8));
        emit AuthorizationCanceled(A, nonce);
        vm.prank(B);
        TUSD8.cancelAuthorization(A, nonce, c.v, c.r, c.s);
        assertTrue(TUSD8.authorizationState(A, nonce));
    }

    function test_step2_contractCallerCanSubmitCancel() public {
        CancelRelay relay = new CancelRelay();
        bytes32 nonce = keccak256("g1-step2");
        Cancel memory c = _signCancel(pkA, nonce);
        vm.prank(B);
        relay.cancel(TUSD8, A, nonce, c.v, c.r, c.s);
        assertTrue(TUSD8.authorizationState(A, nonce));
    }

    function test_step3_cancelledTransferReverts() public {
        bytes32 nonce = keccak256("g1-step3");
        Pay memory p = _signPay(pkA, payee, VALUE, block.timestamp + 15 minutes, block.timestamp + 1 days, nonce);
        Cancel memory c = _signCancel(pkA, nonce);
        vm.prank(B);
        TUSD8.cancelAuthorization(A, nonce, c.v, c.r, c.s);
        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        vm.prank(B);
        _pay(p);
        assertEq(TUSD8.balanceOf(payee), 0);
    }

    function test_step3_cancelTwiceReverts() public {
        bytes32 nonce = keccak256("g1-twice");
        Cancel memory c = _signCancel(pkA, nonce);
        TUSD8.cancelAuthorization(A, nonce, c.v, c.r, c.s);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        TUSD8.cancelAuthorization(A, nonce, c.v, c.r, c.s);
    }

    function test_badSignatureCancelReverts() public {
        bytes32 nonce = keccak256("g1-bad");
        Cancel memory c = _signCancel(uint256(keccak256("someone-else")), nonce);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        TUSD8.cancelAuthorization(A, nonce, c.v, c.r, c.s);
    }

    function test_step5_positiveControl_earlyRevertsThenPaysViaMulticall3() public {
        bytes32 nonce = keccak256("g1-step5");
        Pay memory p = _signPay(pkA, payee, VALUE, block.timestamp + 15 minutes, block.timestamp + 1 days, nonce);
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        vm.prank(B);
        _pay(p);

        vm.warp(block.timestamp + 16 minutes);
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](1);
        calls[0] = IMulticall3.Call3({
            target: address(TUSD8),
            allowFailure: false,
            callData: abi.encodeCall(
                IEIP3009.transferWithAuthorization,
                (p.from, p.to, p.value, p.validAfter, p.validBefore, p.nonce, p.v, p.r, p.s)
            )
        });
        vm.expectEmit(true, true, false, false, address(TUSD8));
        emit AuthorizationUsed(A, nonce);
        vm.prank(B);
        IMulticall3(MULTICALL3).aggregate3(calls);
        assertEq(TUSD8.balanceOf(payee), VALUE);
        assertTrue(TUSD8.authorizationState(A, nonce));
    }
}
