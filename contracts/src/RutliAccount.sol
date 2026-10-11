// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/**
 * @title RutliAccount — "the pact"
 * @notice ERC-4337 (EntryPoint v0.8) smart account for a Swissquote self-custody wallet.
 *
 * Four independent factors, each held by a different party:
 *
 *   P  PASSKEY   P-256 WebAuthn key in the client's phone (Face ID / Touch ID)
 *   C  CARD      secp256k1 key printed on the client's paper recovery card, generated on the
 *                client's device and never seen by anyone else
 *   S  COSIGNER  Swissquote's policy co-signer (HSM in production)
 *   G  GUARDIAN  an independent Swiss guardian (e.g. La Poste or a notary)
 *
 * The pact (enforced below, see {canAuthorize}):
 *
 *   P alone           spend up to a daily allowance per token ("porte-monnaie")
 *   P+S or P+C        anything (the "coffre"); Swissquote screens what it co-signs
 *   S+C               only replace the passkey (lost phone)
 *   S+G               only start a recovery that executes after `recoveryDelay`
 *                     and that the client cancels with P or C
 *   C alone           only start an exit that executes after `exitDelay` (Swissquote is gone)
 *                     and that the client cancels with P or C
 *   S, G or C alone   freeze passkey-only spending for FREEZE_DURATION
 *   S alone, G alone, S+G together: can never move funds.
 *
 * Signature verification only uses OpenZeppelin's audited libraries (ECDSA, P256, WebAuthn).
 * This contract contains policy, not cryptography. Accounts are non-upgradeable EIP-1167 clones:
 * nobody, including Swissquote, can change the rules of a deployed account.
 */
contract RutliAccount is Account, EIP712, Initializable, IERC1271 {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Factors (bit flags)
    // ─────────────────────────────────────────────────────────────────────────────

    uint8 public constant PASSKEY = 1;
    uint8 public constant CARD = 2;
    uint8 public constant COSIGNER = 4;
    uint8 public constant GUARDIAN = 8;

    /// @dev Maximum number of factor signatures in one signature blob (one per factor).
    uint256 private constant MAX_FACTORS = 4;

    /// @dev Length of the rolling-in-fixed-windows allowance period.
    uint256 public constant ALLOWANCE_WINDOW = 1 days;

    /// @dev Upper bound for any security delay.
    uint32 public constant MAX_DELAY = 365 days;

    /// @dev Maximum number of tokens that can carry a passkey-only allowance.
    uint256 public constant MAX_ALLOWANCE_TOKENS = 8;

    /// @dev EIP-712 type used to make ERC-1271 signatures account-specific (no cross-account replay).
    bytes32 private constant RUTLI_MESSAGE_TYPEHASH = keccak256("RutliMessage(bytes32 hash)");

    // ─────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────

    struct InitConfig {
        bytes32 passkeyX;
        bytes32 passkeyY;
        address card;
        address cosigner;
        address guardian;
        uint32 recoveryDelay;
        uint32 exitDelay;
        address[] allowanceTokens;
        uint128[] allowanceLimits;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Allowance {
        uint128 limit;
        uint128 spent;
        uint64 windowStart;
    }

    struct PendingRecovery {
        bytes32 newPasskeyX;
        bytes32 newPasskeyY;
        address newCard;
        uint64 executeAfter; // 0 = nothing pending
        uint64 epoch;
        bytes32 reasonHash; // hash of the off-chain evidence (lost keys, certificate of inheritance, ...)
    }

    struct PendingExit {
        address card;
        uint64 executeAfter; // 0 = nothing pending
        uint64 epoch;
    }

    struct AccountState {
        bytes32 passkeyX;
        bytes32 passkeyY;
        address card;
        address cosigner;
        address guardian;
        uint32 recoveryDelay;
        uint32 exitDelay;
        uint64 frozenUntil;
        uint64 securityEpoch;
        bool sovereign;
        PendingRecovery pendingRecovery;
        PendingExit pendingExit;
        uint32 minDelay;
        uint32 freezeDuration;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Immutables (shared by every clone, fixed at implementation deployment)
    // ─────────────────────────────────────────────────────────────────────────────

    IEntryPoint private immutable _ENTRY_POINT;

    /// @notice Smallest delay an account may configure (production: >= 1 day; local demo: seconds).
    uint32 public immutable MIN_DELAY;

    /// @notice How long a freeze lasts.
    uint32 public immutable FREEZE_DURATION;

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────

    bytes32 private _passkeyX;
    bytes32 private _passkeyY;

    /// @notice Client's paper recovery card (factor C).
    address public card;
    /// @notice Swissquote's policy co-signer for this client (factor S). Zero in sovereign mode.
    address public cosigner;
    /// @notice Independent guardian for this client (factor G). Zero in sovereign mode.
    address public guardian;

    /// @notice Delay of the S+G recovery route.
    uint32 public recoveryDelay;
    /// @notice Delay of the card-only exit route.
    uint32 public exitDelay;
    /// @notice Passkey-only spending is blocked until this timestamp.
    uint64 public frozenUntil;
    /// @notice Incremented by every change of keys. Pending requests from an older epoch are void.
    uint64 public securityEpoch;
    /// @notice True after an exit: Swissquote and the guardian are removed and the card has full control.
    bool public sovereign;

    PendingRecovery private _pendingRecovery;
    PendingExit private _pendingExit;

    mapping(address token => Allowance) private _allowances;
    address[] private _allowanceTokens;

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event AccountInitialized(
        bytes32 passkeyX,
        bytes32 passkeyY,
        address indexed card,
        address indexed cosigner,
        address indexed guardian,
        uint32 recoveryDelay,
        uint32 exitDelay
    );
    event Spent(address indexed token, address indexed to, uint256 amount, uint256 spentInWindow, uint256 limit);
    event Executed(address indexed target, uint256 value, bytes4 selector);
    event AllowanceSet(address indexed token, uint256 limit);
    event PasskeyRotated(bytes32 passkeyX, bytes32 passkeyY, uint64 epoch);
    event CardRotated(address indexed card, uint64 epoch);
    event CosignerChanged(address indexed cosigner, uint64 epoch);
    event GuardianChanged(address indexed guardian, uint64 epoch);
    event DelaysChanged(uint32 recoveryDelay, uint32 exitDelay);
    event Frozen(uint64 until);
    event Unfrozen();
    event RecoveryInitiated(
        bytes32 newPasskeyX,
        bytes32 newPasskeyY,
        address indexed newCard,
        uint64 executeAfter,
        bytes32 reasonHash,
        uint64 epoch
    );
    event RecoveryCancelled(uint64 epoch);
    event RecoveryFinalized(bytes32 newPasskeyX, bytes32 newPasskeyY, address indexed newCard, uint64 epoch);
    event ExitInitiated(address indexed card, uint64 executeAfter, uint64 epoch);
    event ExitCancelled(uint64 epoch);
    event ExitFinalized(address indexed card, uint64 epoch);

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────

    error Unauthorized(address caller);
    error SelfCallForbidden();
    error InvalidPasskey();
    error InvalidAddress(address account);
    error DuplicateKey(address account);
    error DelayOutOfBounds(uint256 delay);
    error AccountFrozen(uint64 until);
    error NoAllowance(address token);
    error AllowanceExceeded(address token, uint256 requested, uint256 remaining);
    error TooManyAllowanceTokens();
    error LengthMismatch();
    error NativeTransferFailed();
    error NothingPending();
    error NotReady(uint64 executeAfter);
    error StaleRequest();
    error SovereignMode();
    error InvalidConstructorArgs();

    // ─────────────────────────────────────────────────────────────────────────────
    // Construction / initialization
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @param entryPoint_ ERC-4337 EntryPoint v0.8 used by every clone of this implementation.
     * @param minDelay_ smallest allowed recovery/exit delay (use >= 1 days in production).
     * @param freezeDuration_ duration of a freeze.
     */
    constructor(IEntryPoint entryPoint_, uint32 minDelay_, uint32 freezeDuration_) EIP712("RutliAccount", "1") {
        if (address(entryPoint_) == address(0) || minDelay_ == 0 || minDelay_ > MAX_DELAY || freezeDuration_ == 0) {
            revert InvalidConstructorArgs();
        }
        _ENTRY_POINT = entryPoint_;
        MIN_DELAY = minDelay_;
        FREEZE_DURATION = freezeDuration_;
        _disableInitializers(); // the implementation itself can never be initialized or used
    }

    /**
     * @notice Called once by {RutliFactory} in the same transaction that deploys the clone.
     */
    function initialize(InitConfig calldata cfg) external initializer {
        _setPasskey(cfg.passkeyX, cfg.passkeyY);
        if (cfg.card == address(0)) revert InvalidAddress(address(0));
        _requireUsableAddress(cfg.card);
        _requireUsableAddress(cfg.cosigner);
        _requireUsableAddress(cfg.guardian);
        _requireDistinct(cfg.card, cfg.cosigner, cfg.guardian);
        card = cfg.card;
        cosigner = cfg.cosigner;
        guardian = cfg.guardian;
        _setDelays(cfg.recoveryDelay, cfg.exitDelay);

        uint256 n = cfg.allowanceTokens.length;
        if (n != cfg.allowanceLimits.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; ++i) {
            _setAllowance(cfg.allowanceTokens[i], cfg.allowanceLimits[i]);
        }

        emit AccountInitialized(
            cfg.passkeyX, cfg.passkeyY, cfg.card, cfg.cosigner, cfg.guardian, cfg.recoveryDelay, cfg.exitDelay
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ERC-4337
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc Account
    function entryPoint() public view override returns (IEntryPoint) {
        return _ENTRY_POINT;
    }

    /**
     * @dev Validation = (1) verify every factor signature over `userOpHash`, (2) check that the set of
     * factors that signed is allowed to call the function encoded in `userOp.callData`.
     *
     * Nothing time-dependent is evaluated here (ERC-7562 forbids TIMESTAMP during validation):
     * delays, freezes and allowances are enforced in the execution phase.
     *
     * Since EntryPoint v0.8, `userOpHash` is an EIP-712 digest that ECDSA keys can sign directly,
     * and that a passkey signs as the WebAuthn challenge.
     */
    function _validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, bytes calldata signature)
        internal
        view
        override
        returns (uint256)
    {
        if (userOp.callData.length < 4) return ERC4337Utils.SIG_VALIDATION_FAILED;
        bytes4 selector = bytes4(userOp.callData[:4]);
        uint8 factors = _verifyFactors(userOpHash, signature);
        return
            canAuthorize(selector, factors) ? ERC4337Utils.SIG_VALIDATION_SUCCESS : ERC4337Utils.SIG_VALIDATION_FAILED;
    }

    /**
     * @notice The pact, as code. Returns whether a set of factors may call `selector` through the EntryPoint.
     * @dev Public so that anyone (the client app's "Radiographie", an auditor, the regulator) can query the
     * exact rules of a live account on-chain instead of trusting documentation.
     */
    function canAuthorize(bytes4 selector, uint8 factors) public view returns (bool) {
        bool p = factors & PASSKEY != 0;
        bool c = factors & CARD != 0;
        bool s = factors & COSIGNER != 0;
        bool g = factors & GUARDIAN != 0;
        bool sov = sovereign;
        bool full = (p && (s || c)) || (sov && c);

        // Porte-monnaie: the passkey alone, within the daily allowance (checked at execution).
        if (selector == this.spend.selector) return p || full;

        // Coffre: arbitrary calls.
        if (selector == this.execute.selector || selector == this.executeBatch.selector) return full;

        // Key management.
        if (selector == this.rotatePasskey.selector) return full || (s && c); // S+C: lost phone
        if (selector == this.rotateCard.selector) return full; // P+S: lost card
        if (selector == this.setCosigner.selector) return full; // P+S: Swissquote key rotation
        if (
            selector == this.setGuardian.selector || selector == this.setAllowance.selector
                || selector == this.setDelays.selector || selector == this.unfreeze.selector
        ) return (p && c) || (sov && c); // weakening protections requires the client's two own factors

        // Protective actions: any single non-passkey factor can freeze passkey-only spending.
        if (selector == this.freeze.selector) return s || g || c;

        // Delayed routes and their cancellation by the client.
        if (selector == this.initiateRecovery.selector) return s && g && !sov;
        if (selector == this.cancelRecovery.selector) return p || c;
        if (selector == this.initiateExit.selector) return c && !sov;
        if (selector == this.cancelExit.selector) return p || c;

        return false; // default deny (includes executeUserOp and unknown selectors)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Factor signatures
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @dev Signature blob layout (all lengths checked, never reverts on malformed input):
     *
     *   uint8 count                                      1 ≤ count ≤ 4
     *   count × [ uint8 factor | uint16 size | bytes data(size) ]
     *
     * `factor` is one of PASSKEY, CARD, COSIGNER, GUARDIAN; each factor may appear once.
     * PASSKEY data: abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)
     *               (the layout of {WebAuthn-tryDecodeAuth}); the challenge is the 32-byte `hash`.
     * other data:   a 65-byte ECDSA signature (r, s, v) of `hash`.
     *
     * Returns the bitmask of verified factors, or 0 if anything is invalid (one bad entry voids everything).
     */
    function _verifyFactors(bytes32 hash, bytes calldata sig) internal view returns (uint8 mask) {
        uint256 len = sig.length;
        if (len < 4) return 0;
        uint256 count = uint8(sig[0]);
        if (count == 0 || count > MAX_FACTORS) return 0;

        uint256 cursor = 1;
        for (uint256 i = 0; i < count; ++i) {
            if (len - cursor < 3) return 0; // invariant: cursor <= len
            uint8 factor = uint8(sig[cursor]);
            uint256 size = (uint256(uint8(sig[cursor + 1])) << 8) | uint256(uint8(sig[cursor + 2]));
            cursor += 3;
            if (len - cursor < size) return 0;
            if (!_isSingleFactor(factor) || (mask & factor) != 0) return 0;
            if (!_verifyFactor(factor, hash, sig[cursor:cursor + size])) return 0;
            mask |= factor;
            cursor += size;
        }
        if (cursor != len) return 0; // no trailing bytes
    }

    function _verifyFactor(uint8 factor, bytes32 hash, bytes calldata data) private view returns (bool) {
        if (factor == PASSKEY) {
            bytes32 x = _passkeyX;
            bytes32 y = _passkeyY;
            if (x == bytes32(0) && y == bytes32(0)) return false;
            (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(data);
            if (!decoded) return false;
            // requireUV = true: Face ID / fingerprint / device PIN must have been checked by the authenticator.
            return WebAuthn.verify(abi.encodePacked(hash), auth, x, y, true);
        }
        address expected = factor == CARD ? card : (factor == COSIGNER ? cosigner : guardian);
        if (expected == address(0)) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, data);
        return err == ECDSA.RecoverError.NoError && recovered == expected;
    }

    function _isSingleFactor(uint8 factor) private pure returns (bool) {
        return factor == PASSKEY || factor == CARD || factor == COSIGNER || factor == GUARDIAN;
    }

    function _hasFullAuthority(uint8 factors) private view returns (bool) {
        bool p = factors & PASSKEY != 0;
        bool c = factors & CARD != 0;
        bool s = factors & COSIGNER != 0;
        return (p && (s || c)) || (sovereign && c);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ERC-1271
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Hash that factors sign for ERC-1271: binds `hash` to this account and chain, so a signature
     * produced for one Rütli account can never be replayed on another account that shares a key.
     */
    function replaySafeHash(bytes32 hash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RUTLI_MESSAGE_TYPEHASH, hash)));
    }

    /**
     * @notice ERC-1271. Requires the same authority as {execute} (P+S, P+C, or the card in sovereign mode):
     * an off-chain signature (e.g. an EIP-2612 permit) can move funds, so a passkey alone must never produce one.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        return _rawSignatureValidation(replaySafeHash(hash), signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    /// @dev See {AbstractSigner}. Full authority required.
    function _rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view override returns (bool) {
        return _hasFullAuthority(_verifyFactors(hash, signature));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Execution (through the EntryPoint; the card may call directly in sovereign mode, and for protective actions)
    // ─────────────────────────────────────────────────────────────────────────────

    modifier onlyEntryPointOrSovereignCard() {
        _checkEntryPointOrSovereignCard();
        _;
    }

    /**
     * @dev Protective actions the card may also perform as a plain transaction from its own address.
     * Purpose: the client can freeze, cancel a recovery or cancel an exit even if every Swissquote server
     * (bundler, paymaster, co-signer) is down or refuses to relay — only a public RPC and a few cents of gas.
     */
    modifier onlyEntryPointOrCard() {
        _checkEntryPointOrCard();
        _;
    }

    function _checkEntryPointOrCard() private view {
        if (msg.sender != address(_ENTRY_POINT) && msg.sender != card) revert Unauthorized(msg.sender);
    }

    function _checkEntryPointOrSovereignCard() private view {
        if (msg.sender != address(_ENTRY_POINT) && !(sovereign && msg.sender == card)) {
            revert Unauthorized(msg.sender);
        }
    }

    /**
     * @notice Porte-monnaie: transfer `amount` of `token` (address(0) = native ETH) within the daily allowance.
     * Authorized by the passkey alone. Blocked while the account is frozen.
     */
    function spend(address token, address to, uint256 amount) external onlyEntryPointOrSovereignCard {
        if (block.timestamp < frozenUntil) revert AccountFrozen(frozenUntil);
        if (to == address(0) || to == address(this)) revert InvalidAddress(to);

        Allowance storage a = _allowances[token];
        uint256 limit = a.limit;
        if (limit == 0) revert NoAllowance(token);

        if (block.timestamp >= uint256(a.windowStart) + ALLOWANCE_WINDOW) {
            a.windowStart = uint64(block.timestamp);
            a.spent = 0;
        }
        uint256 alreadySpent = a.spent;
        uint256 newSpent = alreadySpent + amount;
        if (newSpent > limit) {
            revert AllowanceExceeded(token, amount, limit > alreadySpent ? limit - alreadySpent : 0);
        }
        // forge-lint: disable-next-line(unsafe-typecast) newSpent <= limit <= type(uint128).max
        a.spent = uint128(newSpent);

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Spent(token, to, amount, newSpent, limit);
    }

    /// @notice Coffre: arbitrary call. Authorized by P+S, P+C (or the card in sovereign mode).
    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPointOrSovereignCard {
        _call(target, value, data);
    }

    /// @notice Coffre: batch of arbitrary calls, atomic. Same authority as {execute}.
    function executeBatch(Call[] calldata calls) external onlyEntryPointOrSovereignCard {
        uint256 n = calls.length;
        for (uint256 i = 0; i < n; ++i) {
            _call(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(address target, uint256 value, bytes calldata data) private {
        // Calling ourselves would let a P+S/P+C signature reach functions that the pact reserves to
        // other factor sets (e.g. setGuardian). Admin functions must go through their own selector.
        if (target == address(this)) revert SelfCallForbidden();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit Executed(target, value, data.length >= 4 ? bytes4(data[:4]) : bytes4(0));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Key management
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Replace the passkey (new phone). S+C (lost phone), or full authority.
    function rotatePasskey(bytes32 x, bytes32 y) external onlyEntryPointOrSovereignCard {
        _setPasskey(x, y);
        frozenUntil = 0; // the thief's device is now useless
        _bumpEpoch();
        emit PasskeyRotated(x, y, securityEpoch);
    }

    /// @notice Replace the recovery card. P+S (lost card), or full authority.
    function rotateCard(address newCard) external onlyEntryPointOrSovereignCard {
        if (newCard == address(0)) revert InvalidAddress(address(0));
        _requireUsableAddress(newCard);
        _requireDistinct(newCard, cosigner, guardian);
        card = newCard;
        _bumpEpoch();
        emit CardRotated(newCard, securityEpoch);
    }

    /// @notice Replace (or remove) Swissquote's co-signer key. P+S (key rotation), or full authority.
    function setCosigner(address newCosigner) external onlyEntryPointOrSovereignCard {
        if (sovereign) revert SovereignMode();
        _requireUsableAddress(newCosigner);
        _requireDistinct(card, newCosigner, guardian);
        cosigner = newCosigner;
        _bumpEpoch();
        emit CosignerChanged(newCosigner, securityEpoch);
    }

    /// @notice Replace (or remove) the independent guardian. P+C only.
    function setGuardian(address newGuardian) external onlyEntryPointOrSovereignCard {
        if (sovereign) revert SovereignMode();
        _requireUsableAddress(newGuardian);
        _requireDistinct(card, cosigner, newGuardian);
        guardian = newGuardian;
        _bumpEpoch();
        emit GuardianChanged(newGuardian, securityEpoch);
    }

    /// @notice Set the passkey-only daily allowance for `token` (0 disables). P+C only.
    function setAllowance(address token, uint128 limit) external onlyEntryPointOrSovereignCard {
        _setAllowance(token, limit);
    }

    /// @notice Change the security delays (bounded by MIN_DELAY and MAX_DELAY). P+C only.
    function setDelays(uint32 newRecoveryDelay, uint32 newExitDelay) external onlyEntryPointOrSovereignCard {
        _setDelays(newRecoveryDelay, newExitDelay);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Freeze ("blocking is easy, unblocking is hard")
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Block passkey-only spending for FREEZE_DURATION. Any single factor among S, G, C
    /// (the card also directly, without any infrastructure).
    function freeze() external onlyEntryPointOrCard {
        uint64 until = uint64(block.timestamp + FREEZE_DURATION);
        frozenUntil = until;
        emit Frozen(until);
    }

    /// @notice Lift a freeze early. P+C only (rotating the passkey also lifts it).
    function unfreeze() external onlyEntryPointOrSovereignCard {
        frozenUntil = 0;
        emit Unfrozen();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Recovery: Swissquote + guardian, delayed, cancellable by the client
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Start replacing BOTH client factors (passkey and card). S+G only.
     * Executes after `recoveryDelay` via {finalizeRecovery}. The client cancels with P or C.
     * Also used for inheritance: the new keys belong to the heirs, `reasonHash` commits to the evidence.
     */
    function initiateRecovery(bytes32 newPasskeyX, bytes32 newPasskeyY, address newCard, bytes32 reasonHash)
        external
        onlyEntryPointOrSovereignCard
    {
        if (sovereign) revert SovereignMode();
        if (!P256.isValidPublicKey(newPasskeyX, newPasskeyY)) revert InvalidPasskey();
        if (newCard == address(0)) revert InvalidAddress(address(0));
        _requireUsableAddress(newCard);
        _requireDistinct(newCard, cosigner, guardian);

        uint64 executeAfter = uint64(block.timestamp + recoveryDelay);
        uint64 epoch = securityEpoch;
        _pendingRecovery = PendingRecovery({
            newPasskeyX: newPasskeyX,
            newPasskeyY: newPasskeyY,
            newCard: newCard,
            executeAfter: executeAfter,
            epoch: epoch,
            reasonHash: reasonHash
        });
        emit RecoveryInitiated(newPasskeyX, newPasskeyY, newCard, executeAfter, reasonHash, epoch);
    }

    /// @notice Cancel a pending recovery. The passkey or the card (the card also directly, as a plain transaction:
    /// even if Swissquote and the guardian collude and refuse to relay the cancellation).
    function cancelRecovery() external onlyEntryPointOrCard {
        if (_pendingRecovery.executeAfter == 0) revert NothingPending();
        delete _pendingRecovery;
        emit RecoveryCancelled(securityEpoch);
    }

    /// @notice Execute a matured recovery. Anyone may call it (no signature needed, nothing to steal).
    function finalizeRecovery() external {
        PendingRecovery memory r = _pendingRecovery;
        if (r.executeAfter == 0) revert NothingPending();
        if (block.timestamp < r.executeAfter) revert NotReady(r.executeAfter);
        if (r.epoch != securityEpoch) revert StaleRequest();
        _requireDistinct(r.newCard, cosigner, guardian);

        delete _pendingRecovery; // consumed (deleted first so that _bumpEpoch does not report it as cancelled)
        _bumpEpoch(); // voids a pending exit, if any
        _setPasskey(r.newPasskeyX, r.newPasskeyY);
        card = r.newCard;
        frozenUntil = 0;
        emit RecoveryFinalized(r.newPasskeyX, r.newPasskeyY, r.newCard, securityEpoch);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Exit: the card alone, delayed — works even if Swissquote has disappeared
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Start the exit. The card alone, through the EntryPoint OR as a plain transaction sent by the card
     * itself (so that no Swissquote infrastructure — bundler, paymaster, website — is needed).
     * Executes after `exitDelay` via {finalizeExit}. The client cancels with P or C.
     */
    function initiateExit() external onlyEntryPointOrCard {
        if (sovereign) revert SovereignMode();
        uint64 executeAfter = uint64(block.timestamp + exitDelay);
        uint64 epoch = securityEpoch;
        _pendingExit = PendingExit({card: card, executeAfter: executeAfter, epoch: epoch});
        emit ExitInitiated(card, executeAfter, epoch);
    }

    /// @notice Cancel a pending exit. The passkey or the card (the card also directly).
    function cancelExit() external onlyEntryPointOrCard {
        if (_pendingExit.executeAfter == 0) revert NothingPending();
        delete _pendingExit;
        emit ExitCancelled(securityEpoch);
    }

    /**
     * @notice Execute a matured exit: Swissquote's co-signer and the guardian are removed and the card gets
     * full control (sovereign mode). Anyone may call it.
     */
    function finalizeExit() external {
        PendingExit memory e = _pendingExit;
        if (e.executeAfter == 0) revert NothingPending();
        if (block.timestamp < e.executeAfter) revert NotReady(e.executeAfter);
        if (e.epoch != securityEpoch || e.card != card) revert StaleRequest();

        delete _pendingExit; // consumed (deleted first so that _bumpEpoch does not report it as cancelled)
        _bumpEpoch(); // voids a pending recovery, if any
        sovereign = true;
        cosigner = address(0);
        guardian = address(0);
        frozenUntil = 0;
        emit ExitFinalized(e.card, securityEpoch);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    function passkey() external view returns (bytes32 x, bytes32 y) {
        return (_passkeyX, _passkeyY);
    }

    function pendingRecovery() external view returns (PendingRecovery memory) {
        return _pendingRecovery;
    }

    function pendingExit() external view returns (PendingExit memory) {
        return _pendingExit;
    }

    function allowanceTokens() external view returns (address[] memory) {
        return _allowanceTokens;
    }

    /**
     * @notice Allowance of `token` as seen right now (the window is reset lazily on the next spend).
     */
    function allowance(address token)
        external
        view
        returns (uint256 limit, uint256 spentInWindow, uint256 remaining, uint64 windowEnd)
    {
        Allowance memory a = _allowances[token];
        limit = a.limit;
        bool expired = block.timestamp >= uint256(a.windowStart) + ALLOWANCE_WINDOW;
        spentInWindow = expired ? 0 : a.spent;
        remaining = limit > spentInWindow ? limit - spentInWindow : 0;
        // forge-lint: disable-next-line(unsafe-typecast) windowStart is a uint64 timestamp, + 1 day cannot overflow
        windowEnd = expired ? 0 : uint64(uint256(a.windowStart) + ALLOWANCE_WINDOW);
    }

    function isFrozen() external view returns (bool) {
        return block.timestamp < frozenUntil;
    }

    /// @notice Everything the "Radiographie" screen needs, in one call.
    function describe() external view returns (AccountState memory state) {
        state = AccountState({
            passkeyX: _passkeyX,
            passkeyY: _passkeyY,
            card: card,
            cosigner: cosigner,
            guardian: guardian,
            recoveryDelay: recoveryDelay,
            exitDelay: exitDelay,
            frozenUntil: frozenUntil,
            securityEpoch: securityEpoch,
            sovereign: sovereign,
            pendingRecovery: _pendingRecovery,
            pendingExit: _pendingExit,
            minDelay: MIN_DELAY,
            freezeDuration: FREEZE_DURATION
        });
    }

    function version() external pure returns (string memory) {
        return "rutli-account-1.0.0";
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────────

    function _setPasskey(bytes32 x, bytes32 y) private {
        if (!P256.isValidPublicKey(x, y)) revert InvalidPasskey();
        _passkeyX = x;
        _passkeyY = y;
    }

    function _setDelays(uint32 newRecoveryDelay, uint32 newExitDelay) private {
        if (newRecoveryDelay < MIN_DELAY || newRecoveryDelay > MAX_DELAY) revert DelayOutOfBounds(newRecoveryDelay);
        if (newExitDelay < MIN_DELAY || newExitDelay > MAX_DELAY) revert DelayOutOfBounds(newExitDelay);
        recoveryDelay = newRecoveryDelay;
        exitDelay = newExitDelay;
        emit DelaysChanged(newRecoveryDelay, newExitDelay);
    }

    function _setAllowance(address token, uint128 limit) private {
        if (token == address(this)) revert InvalidAddress(token);
        Allowance storage a = _allowances[token];
        if (!_isListed(token)) {
            if (_allowanceTokens.length >= MAX_ALLOWANCE_TOKENS) revert TooManyAllowanceTokens();
            _allowanceTokens.push(token);
        }
        a.limit = limit;
        emit AllowanceSet(token, limit);
    }

    function _isListed(address token) private view returns (bool) {
        uint256 n = _allowanceTokens.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_allowanceTokens[i] == token) return true;
        }
        return false;
    }

    /// @dev A key must not be this account or the EntryPoint (they cannot sign, and would only confuse).
    function _requireUsableAddress(address key) private view {
        if (key == address(this) || key == address(_ENTRY_POINT)) revert InvalidAddress(key);
    }

    /// @dev Non-zero keys must be pairwise distinct, otherwise one key would count as two factors.
    function _requireDistinct(address a, address b, address c) private pure {
        if (a != address(0) && (a == b || a == c)) revert DuplicateKey(a);
        if (b != address(0) && b == c) revert DuplicateKey(b);
    }

    /// @dev Every change of keys voids all pending requests signed under the previous configuration.
    function _bumpEpoch() private {
        uint64 epoch = securityEpoch;
        if (_pendingRecovery.executeAfter != 0) {
            delete _pendingRecovery;
            emit RecoveryCancelled(epoch);
        }
        if (_pendingExit.executeAfter != 0) {
            delete _pendingExit;
            emit ExitCancelled(epoch);
        }
        unchecked {
            securityEpoch = epoch + 1;
        }
    }
}
