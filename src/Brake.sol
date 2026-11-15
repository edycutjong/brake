// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEIP3009} from "./interfaces/IEIP3009.sol";
import {IERC8004Identity, IERC8004Validation} from "./interfaces/IERC8004.sol";

/// @title Brake — pre-signed stop-payments for stablecoin payment runs
/// @notice Finance signs each line of a payment run twice: an EIP-3009 `transferWithAuthorization` (valid only from
///         payday, held by the keeper) and the matching `cancelAuthorization` (held for the agent). The monitor agent's
///         only on-chain powers are to allow, hold or stop a line. A stop submits the payer's pre-signed cancel to the
///         token, so the token itself refuses the payment. The agent can delay a payment; it can never create one or
///         change where one goes.
/// @dev Brake is the ERC-8004 validator for every line: each decision is answered in the Validation Registry in the
///      same transaction. A failing receipt never rolls back the safety action — it is stored and retried.
contract Brake is ReentrancyGuard {
    // ----------------------------------------------------------------------------------------------------- types

    enum Status {
        NONE,
        OPEN,
        ALLOWED,
        HELD,
        STOPPED,
        CONSUMED, // the nonce was used or cancelled outside Brake; the reconciler resolves TOO_LATE vs EXTERNALLY_CANCELLED
        REISSUED
    }

    struct Line {
        address payee;
        uint256 amount;
        bytes32 nonce;
    }

    struct Run {
        address payer;
        address agent;
        uint256 agentId;
        uint64 validAfter;
        uint64 validBefore;
        uint16 maxStops;
        uint16 alarmAt;
        uint16 stops;
        bool revoked;
        uint32 lineCount;
    }

    struct LineState {
        address payee;
        uint256 amount;
        bytes32 nonce;
        uint64 validAfter;
        uint64 validBefore;
        uint64 agentExpiry;
        Status status;
        bool requested; // ERC-8004 validation request made for this line
        bool receiptPending; // the latest decision's receipt failed and awaits retryReceipt
        uint8 pendingResponse;
        bytes32 pendingReason;
        bytes32 pendingEvidence;
        string pendingUri;
    }

    // --------------------------------------------------------------------------------------------------- storage

    IEIP3009 public immutable token;
    IERC8004Identity public immutable identity;
    IERC8004Validation public immutable validation;

    uint256 public constant MAX_LINES = 64;
    uint8 public constant RESPONSE_ALLOW = 100;
    uint8 public constant RESPONSE_STOP = 0;
    bytes32 public constant TAG_ALLOW = "ALLOW";
    bytes32 public constant TAG_FINANCE_ALLOW = "FINANCE_ALLOW";

    mapping(bytes32 runId => Run) internal _runs;
    mapping(bytes32 runId => mapping(uint256 idx => LineState)) internal _lines;
    /// a nonce may back at most one Brake line per payer
    mapping(address payer => mapping(bytes32 nonce => bool)) public nonceRegistered;

    // ---------------------------------------------------------------------------------------------------- events

    event RunOpened(bytes32 indexed runId, address indexed payer, address agent, uint256 lines, uint64 validAfter);
    event LineAllowed(bytes32 indexed runId, uint256 indexed idx, bytes32 evidenceHash, address by);
    event LineStopped(bytes32 indexed runId, uint256 indexed idx, bytes32 reason, bytes32 evidenceHash, address by);
    event LineHeld(bytes32 indexed runId, uint256 indexed idx, bytes32 reason, bytes32 evidenceHash);
    event StopConsumed(bytes32 indexed runId, uint256 indexed idx);
    event ReceiptFailed(bytes32 indexed runId, uint256 indexed idx);
    event ReceiptRecorded(bytes32 indexed runId, uint256 indexed idx, bytes32 requestHash, uint8 response, bytes32 tag);
    event StopAlarm(bytes32 indexed runId, uint16 stops);
    event AgentRevoked(bytes32 indexed runId);
    event LineReissued(bytes32 indexed runId, uint256 oldIdx, uint256 newIdx);

    // ---------------------------------------------------------------------------------------------------- errors

    error NotAgent();
    error AgentExpired();
    error GrantRevoked();
    error StopBudgetExhausted();
    error NotPayer();
    error UnknownLine();
    error UnknownReason();
    error AgentNotBound();
    error AgentNotOwned();
    error BrakeNotApproved();
    error RunExists();
    error BadRun();
    error BadLine();
    error NonceUnavailable();
    error BadTransition(Status from);
    error NoPendingReceipt();
    error NoCode(address target);
    error LengthMismatch();

    // ------------------------------------------------------------------------------------------------ constructor

    constructor(IEIP3009 token_, IERC8004Identity identity_, IERC8004Validation validation_) {
        // a high-level try/catch does not catch a call to an address without code
        if (address(token_).code.length == 0) revert NoCode(address(token_));
        if (address(identity_).code.length == 0) revert NoCode(address(identity_));
        if (address(validation_).code.length == 0) revert NoCode(address(validation_));
        token = token_;
        identity = identity_;
        validation = validation_;
    }

    // ------------------------------------------------------------------------------------------------------ payer

    /// @notice Register a signed payment run and grant the monitor agent its cancel-only powers.
    /// @dev The payer must own `agentId` in the ERC-8004 Identity Registry, `agent` must be that agentId's bound wallet,
    ///      and Brake must be the agentId's single-token approved address (so it can open validation requests).
    function openRun(
        bytes32 runId,
        uint256 agentId,
        address agent,
        uint64 agentExpiry,
        uint16 maxStops,
        uint16 alarmAt,
        uint64 validAfter,
        uint64 validBefore,
        Line[] calldata lines
    ) external nonReentrant {
        if (_runs[runId].payer != address(0)) revert RunExists();
        if (lines.length == 0 || lines.length > MAX_LINES) revert BadRun();
        if (validBefore <= validAfter || agentExpiry <= block.timestamp) revert BadRun();
        if (maxStops == 0 || alarmAt == 0 || alarmAt > maxStops) revert BadRun();
        if (identity.ownerOf(agentId) != msg.sender) revert AgentNotOwned();
        if (agent == address(0) || identity.getAgentWallet(agentId) != agent) revert AgentNotBound();
        if (identity.getApproved(agentId) != address(this)) revert BrakeNotApproved();

        _runs[runId] = Run({
            payer: msg.sender,
            agent: agent,
            agentId: agentId,
            validAfter: validAfter,
            validBefore: validBefore,
            maxStops: maxStops,
            alarmAt: alarmAt,
            stops: 0,
            revoked: false,
            lineCount: uint32(lines.length)
        });

        for (uint256 i; i < lines.length; ++i) {
            _addLine(runId, i, msg.sender, lines[i], validAfter, validBefore, agentExpiry);
        }
        emit RunOpened(runId, msg.sender, agent, lines.length, validAfter);
        for (uint256 i; i < lines.length; ++i) {
            _request(runId, i);
        }
    }

    /// @notice Revoke the agent's grant for a run. Payments already signed are unaffected.
    function revokeAgent(bytes32 runId) external {
        Run storage run = _payerRun(runId);
        run.revoked = true;
        emit AgentRevoked(runId);
    }

    /// @notice Finance stops a line itself: no stop budget, same LineStopped + ERC-8004 receipt as an agent stop.
    function financeStop(
        bytes32 runId,
        uint256 idx,
        bytes32 reason,
        bytes32 evidenceHash,
        string calldata uri,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (Status) {
        _payerRun(runId);
        return _stop(runId, idx, reason, evidenceHash, uri, v, r, s, false);
    }

    /// @notice Re-issue a stopped line to a (verified) payee with a fresh nonce and its own payment window.
    /// @dev The fresh line's agent expiry is its own validBefore, so monitoring outlives the original grant.
    function reissue(bytes32 runId, uint256 oldIdx, Line calldata fresh, uint64 validAfter, uint64 validBefore)
        external
        nonReentrant
        returns (uint256 newIdx)
    {
        Run storage run = _payerRun(runId);
        LineState storage old = _line(runId, oldIdx);
        if (old.status != Status.STOPPED) revert BadTransition(old.status);
        if (validBefore <= validAfter || validBefore <= block.timestamp) revert BadRun();
        if (run.lineCount >= MAX_LINES) revert BadRun();
        old.status = Status.REISSUED;
        newIdx = run.lineCount;
        run.lineCount += 1;
        _addLine(runId, newIdx, run.payer, fresh, validAfter, validBefore, validBefore);
        emit LineReissued(runId, oldIdx, newIdx);
        _request(runId, newIdx);
    }

    // ------------------------------------------------------------------------------------------- agent or payer

    /// @notice Record ALLOW decisions. Agent: OPEN|ALLOWED -> ALLOWED (re-affirm on a new evidence revision).
    ///         Payer (FINANCE_ALLOW): OPEN|HELD -> ALLOWED.
    function allow(bytes32 runId, uint256[] calldata idx, bytes32[] calldata evidenceHash, string[] calldata uri)
        external
        nonReentrant
    {
        if (idx.length != evidenceHash.length || idx.length != uri.length) revert LengthMismatch();
        Run storage run = _run(runId);
        bool byPayer = msg.sender == run.payer;
        if (!byPayer && msg.sender != run.agent) revert NotAgent();
        for (uint256 i; i < idx.length; ++i) {
            LineState storage l = _line(runId, idx[i]);
            if (byPayer) {
                if (l.status != Status.OPEN && l.status != Status.HELD) revert BadTransition(l.status);
            } else {
                _checkGrant(run, l);
                if (l.status != Status.OPEN && l.status != Status.ALLOWED) revert BadTransition(l.status);
            }
            l.status = Status.ALLOWED;
            emit LineAllowed(runId, idx[i], evidenceHash[i], msg.sender);
            _receipt(runId, idx[i], RESPONSE_ALLOW, byPayer ? TAG_FINANCE_ALLOW : TAG_ALLOW, evidenceHash[i], uri[i]);
        }
    }

    // ------------------------------------------------------------------------------------------------------ agent

    /// @notice Hold a line for finance: OPEN|ALLOWED -> HELD. No budget. Binds Brake's keeper only — a confirmed risk
    ///         is a token-level `stop`, not a hold.
    function hold(bytes32 runId, uint256 idx, bytes32 reason, bytes32 evidenceHash) external nonReentrant {
        Run storage run = _run(runId);
        if (msg.sender != run.agent) revert NotAgent();
        LineState storage l = _line(runId, idx);
        _checkGrant(run, l);
        if (!isHoldReason(reason)) revert UnknownReason();
        if (l.status != Status.OPEN && l.status != Status.ALLOWED) revert BadTransition(l.status);
        l.status = Status.HELD;
        emit LineHeld(runId, idx, reason, evidenceHash);
    }

    /// @notice Stop a line by submitting the payer's pre-signed cancelAuthorization to the token.
    /// @return the line's status afterwards: STOPPED (now or already — idempotent), CONSUMED, or REISSUED.
    function stop(
        bytes32 runId,
        uint256 idx,
        bytes32 reason,
        bytes32 evidenceHash,
        string calldata uri,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (Status) {
        Run storage run = _run(runId);
        if (msg.sender != run.agent) revert NotAgent();
        return _stop(runId, idx, reason, evidenceHash, uri, v, r, s, true);
    }

    // ----------------------------------------------------------------------------------------------------- anyone

    /// @notice Re-send a line's stored ERC-8004 receipt after a failure. The validator stays Brake.
    function retryReceipt(bytes32 runId, uint256 idx) external nonReentrant {
        LineState storage l = _line(runId, idx);
        if (!l.receiptPending) revert NoPendingReceipt();
        _sendReceipt(runId, idx);
    }

    // ------------------------------------------------------------------------------------------------------ views

    function lineOf(bytes32 runId, uint256 idx) external view returns (Line memory line, Status status) {
        LineState storage l = _line(runId, idx);
        return (Line({payee: l.payee, amount: l.amount, nonce: l.nonce}), l.status);
    }

    function lineDetail(bytes32 runId, uint256 idx) external view returns (LineState memory) {
        return _line(runId, idx);
    }

    function runOf(bytes32 runId) external view returns (Run memory) {
        return _runs[runId];
    }

    /// @notice ERC-8004 request hash for a line: keccak256(runId, idx, payee, amount, nonce).
    function requestHashOf(bytes32 runId, uint256 idx) public view returns (bytes32) {
        LineState storage l = _line(runId, idx);
        return keccak256(abi.encode(runId, idx, l.payee, l.amount, l.nonce));
    }

    function isStopReason(bytes32 reason) public pure returns (bool) {
        return reason == "BANK_CHANGE_UNVERIFIED" || reason == "INVOICE_DISPUTED" || reason == "GOODS_NOT_RECEIVED"
            || reason == "PAYEE_BLACKLISTED" || reason == "DUPLICATE_INVOICE" || reason == "AMOUNT_MISMATCH"
            || reason == "SENDER_LOOKALIKE" || reason == "PAYMENT_DETAIL_CHANGE";
    }

    function isHoldReason(bytes32 reason) public pure returns (bool) {
        return isStopReason(reason) || reason == "INJECTION_FLAGGED" || reason == "BUDGET_EXHAUSTED"
            || reason == "REVIEW_STALE";
    }

    // --------------------------------------------------------------------------------------------------- internal

    function _stop(
        bytes32 runId,
        uint256 idx,
        bytes32 reason,
        bytes32 evidenceHash,
        string calldata uri,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bool byAgent
    ) internal returns (Status) {
        Run storage run = _runs[runId];
        LineState storage l = _line(runId, idx);
        if (byAgent) _checkGrant(run, l);
        if (!isStopReason(reason)) revert UnknownReason();

        Status st = l.status;
        // idempotent: a line Brake already stopped (or re-issued) or already marked CONSUMED returns as-is, no budget
        if (st == Status.STOPPED || st == Status.REISSUED || st == Status.CONSUMED) return st;
        if (st != Status.OPEN && st != Status.ALLOWED && st != Status.HELD) revert BadTransition(st);

        if (token.authorizationState(run.payer, l.nonce)) {
            // used (paid) or cancelled outside Brake — authorizationState cannot tell which; the reconciler reads logs
            l.status = Status.CONSUMED;
            emit StopConsumed(runId, idx);
            return Status.CONSUMED;
        }

        if (byAgent) {
            if (run.stops >= run.maxStops) revert StopBudgetExhausted();
            run.stops += 1;
        }
        l.status = Status.STOPPED;

        token.cancelAuthorization(run.payer, l.nonce, v, r, s); // reverts on a bad signature: nothing changes

        emit LineStopped(runId, idx, reason, evidenceHash, msg.sender);
        if (byAgent && run.stops == run.alarmAt) emit StopAlarm(runId, run.stops);
        _receipt(runId, idx, RESPONSE_STOP, reason, evidenceHash, uri);
        return Status.STOPPED;
    }

    function _addLine(
        bytes32 runId,
        uint256 idx,
        address payer,
        Line calldata line,
        uint64 validAfter,
        uint64 validBefore,
        uint64 agentExpiry
    ) internal {
        if (line.payee == address(0) || line.amount == 0) revert BadLine();
        if (nonceRegistered[payer][line.nonce] || token.authorizationState(payer, line.nonce)) {
            revert NonceUnavailable();
        }
        nonceRegistered[payer][line.nonce] = true;
        LineState storage l = _lines[runId][idx];
        l.payee = line.payee;
        l.amount = line.amount;
        l.nonce = line.nonce;
        l.validAfter = validAfter;
        l.validBefore = validBefore;
        l.agentExpiry = agentExpiry;
        l.status = Status.OPEN;
    }

    /// @dev open the line's ERC-8004 validation request; a failure is recorded, never fatal
    function _request(bytes32 runId, uint256 idx) internal returns (bool) {
        LineState storage l = _lines[runId][idx];
        if (l.requested) return true;
        try validation.validationRequest(address(this), _runs[runId].agentId, "", requestHashOf(runId, idx)) {
            l.requested = true;
            return true;
        } catch {
            emit ReceiptFailed(runId, idx);
            return false;
        }
    }

    function _receipt(bytes32 runId, uint256 idx, uint8 response, bytes32 tag, bytes32 evidenceHash, string memory uri)
        internal
    {
        LineState storage l = _lines[runId][idx];
        l.pendingResponse = response;
        l.pendingReason = tag;
        l.pendingEvidence = evidenceHash;
        l.pendingUri = uri;
        l.receiptPending = true;
        _sendReceipt(runId, idx);
    }

    function _sendReceipt(bytes32 runId, uint256 idx) internal {
        LineState storage l = _lines[runId][idx];
        if (!l.requested && !_request(runId, idx)) return; // ReceiptFailed already emitted; stays pending
        bytes32 rh = requestHashOf(runId, idx);
        try validation.validationResponse(rh, l.pendingResponse, l.pendingUri, l.pendingEvidence, _tagString(l.pendingReason)) {
            l.receiptPending = false;
            emit ReceiptRecorded(runId, idx, rh, l.pendingResponse, l.pendingReason);
        } catch {
            emit ReceiptFailed(runId, idx);
        }
    }

    function _checkGrant(Run storage run, LineState storage l) internal view {
        if (run.revoked) revert GrantRevoked();
        if (block.timestamp > l.agentExpiry) revert AgentExpired();
    }

    function _run(bytes32 runId) internal view returns (Run storage run) {
        run = _runs[runId];
        if (run.payer == address(0)) revert UnknownLine();
    }

    function _payerRun(bytes32 runId) internal view returns (Run storage run) {
        run = _run(runId);
        if (msg.sender != run.payer) revert NotPayer();
    }

    function _line(bytes32 runId, uint256 idx) internal view returns (LineState storage l) {
        l = _lines[runId][idx];
        if (l.status == Status.NONE) revert UnknownLine();
    }

    /// @dev bytes32 short string ("PAYMENT_DETAIL_CHANGE\0\0…") -> "PAYMENT_DETAIL_CHANGE"
    function _tagString(bytes32 tag) internal pure returns (string memory out) {
        uint256 n;
        while (n < 32 && tag[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = tag[i];
        }
        out = string(b);
    }
}
