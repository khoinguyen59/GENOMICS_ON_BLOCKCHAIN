// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { GenomicNFT } from "../GenomicNFT.sol";
import { IGenomicsMetadataErrors } from "../interfaces/IGenomicsMetadataErrors.sol";

/**
 * @title GenomicsEscrowEngine
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Non-custodial auxiliary state machine deployed by GenomicsRegistry managing timelocked
 *         escrow deposits, access grants, pause-blackout dispute window accounting, and RSA-OAEP
 *         key capsule storage.
 * @dev Strictly controlled by its deploying GenomicsRegistry via `onlyRegistry`. Holds zero ERC-20
 *      tokens (all $GENO custody and EIP-2981 settlement stay exclusively in GenomicsRegistry) and
 *      uses zero delegatecall.
 */
contract GenomicsEscrowEngine is IGenomicsMetadataErrors {
    /// @notice Time-bounded researcher decryption license record.
    struct AccessGrant {
        bool isGranted;
        uint256 grantedAt;
        uint256 expiresAt;
    }

    /// @notice Tightly packed timelocked escrow deposit (5 storage slots: buyer+flags packed in slot 0).
    struct EscrowDeposit {
        address buyer;
        bool released;
        bool refunded;
        bool capsuleDelivered;
        address seller;
        uint256 amount;
        uint256 depositTime;
        uint256 disputeWindow;
    }

    /// @notice Pause-blackout accounting state for fair escrow dispute windows.
    struct PauseState {
        uint256 pausedAt;
        uint256 pausedSeconds;
        uint256 lastUnpausedAt;
        uint256 graceCutoff;
    }

    /// @notice Maximum buyer-requested manual escrow confirmation hold extension (7 days).
    uint256 public constant MAX_MANUAL_ESCROW_EXTENSION = 7 days;
    /// @notice Maximum arbitration timeout before buyer may claim a unilateral dispute refund (30 days).
    uint256 public constant DISPUTE_ARBITRATION_TIMEOUT = 30 days;

    address private immutable REGISTRY;
    GenomicNFT private immutable GENOMIC_NFT;

    /// @notice Dataset ID => researcher => active AccessGrant record.
    mapping(uint256 => mapping(address => AccessGrant)) public accessGrants;
    /// @notice Dataset ID => buyer => timelocked EscrowDeposit record.
    mapping(uint256 => mapping(address => EscrowDeposit)) public escrowDeposits;
    /// @notice Dataset ID => buyer => active dispute freeze flag.
    mapping(uint256 => mapping(address => bool)) public escrowDisputed;
    /// @notice Dataset ID => buyer => timestamp when post-delivery dispute was filed.
    mapping(uint256 => mapping(address => uint256)) public escrowDisputedAt;
    /// @notice Dataset ID => buyer => buyer-requested +7-day manual release hold preference.
    mapping(uint256 => mapping(address => bool)) public manualEscrowRelease;

    mapping(uint256 => mapping(address => string)) private _buyerCapsules;
    mapping(uint256 => mapping(address => bytes32)) private _capsuleDeliveryKeyHash;
    mapping(uint256 => mapping(address => bytes32)) private _buyerCapsuleHash;
    mapping(uint256 => mapping(address => bool)) private _directGrantCounted;
    mapping(uint256 => PauseState) private _pauseState;
    mapping(uint256 => mapping(address => uint256)) private _escrowPausedBase;

    /// @notice Thrown when a caller other than the owning GenomicsRegistry invokes a mutator.
    error NotDataOwner();
    /// @notice Thrown when an operation requires DataStatus.Active.
    error DataNotActive();

    modifier onlyRegistry() {
        if (msg.sender != REGISTRY) revert NotDataOwner();
        _;
    }

    /**
     * @notice Bind this escrow & capsule engine permanently to its deploying GenomicsRegistry and GenomicNFT.
     * @param genomicNftAddress Address of the GenomicNFT validator contract.
     */
    constructor(address genomicNftAddress) {
        REGISTRY = msg.sender;
        GENOMIC_NFT = GenomicNFT(genomicNftAddress);
    }

    function _isEscrowPending(EscrowDeposit storage d) internal view returns (bool) {
        return d.amount > 0 && !d.released && !d.refunded;
    }

    function _isGrantActive(AccessGrant storage g) internal view returns (bool) {
        return g.isGranted && block.timestamp < g.expiresAt;
    }

    function _clearBuyerCapsule(uint256 dataId, address user) internal {
        delete _buyerCapsules[dataId][user];
        delete _capsuleDeliveryKeyHash[dataId][user];
        delete _buyerCapsuleHash[dataId][user];
    }

    function _resetEscrowFlags(uint256 dataId, address user) internal {
        escrowDisputed[dataId][user] = false;
        escrowDisputedAt[dataId][user] = 0;
        manualEscrowRelease[dataId][user] = false;
    }

    function _setGrant(uint256 dataId, address user, uint256 duration) internal returns (uint256 expires) {
        expires = block.timestamp + duration;
        AccessGrant storage g = accessGrants[dataId][user];
        g.isGranted = true;
        g.grantedAt = block.timestamp;
        g.expiresAt = expires;
    }

    function _baseEscrowLockDeadline(
        EscrowDeposit storage d,
        uint256 dataId,
        address buyer
    ) internal view returns (uint256) {
        return d.depositTime + d.disputeWindow + (manualEscrowRelease[dataId][buyer] ? MAX_MANUAL_ESCROW_EXTENSION : 0);
    }

    function _escrowLockDeadline(
        EscrowDeposit storage d,
        uint256 dataId,
        address buyer,
        bool includeManual
    ) internal view returns (uint256 lockDl) {
        PauseState storage ps = _pauseState[dataId];
        uint256 base = _escrowPausedBase[dataId][buyer];
        uint256 completedDelta = ps.pausedSeconds > base ? ps.pausedSeconds - base : 0;
        uint256 completedDl = (
            includeManual ? _baseEscrowLockDeadline(d, dataId, buyer) : d.depositTime + d.disputeWindow
        ) + completedDelta;
        if (
            ps.lastUnpausedAt > d.depositTime &&
            completedDl > ps.graceCutoff &&
            ps.lastUnpausedAt + 15 minutes > completedDl
        ) {
            completedDl = ps.lastUnpausedAt + 15 minutes;
        }
        lockDl = ps.pausedAt > 0 ? completedDl + (block.timestamp - ps.pausedAt) : completedDl;
    }

    function _clearSettledEscrow(uint256 dataId, address user) internal {
        EscrowDeposit storage existing = escrowDeposits[dataId][user];
        if (existing.amount > 0) {
            if (!existing.released && !existing.refunded) revert EscrowAlreadyActive();
            delete escrowDeposits[dataId][user];
        }
        _resetEscrowFlags(dataId, user);
        if (!_isGrantActive(accessGrants[dataId][user])) _clearBuyerCapsule(dataId, user);
    }

    function _requireActiveEscrow(uint256 dataId, address buyer) internal view returns (EscrowDeposit storage dep) {
        dep = escrowDeposits[dataId][buyer];
        if (!_isEscrowPending(dep)) revert EscrowNotActive();
    }

    function _requireDeliveredUndisputed(uint256 dataId, address buyer) internal view returns (EscrowDeposit storage dep) {
        dep = _requireActiveEscrow(dataId, buyer);
        if (!dep.capsuleDelivered) revert CapsuleNotDelivered();
        if (escrowDisputed[dataId][buyer]) revert EscrowDisputedError();
    }

    function _requireActiveGrant(uint256 dataId, address researcher) internal view {
        AccessGrant storage g = accessGrants[dataId][researcher];
        if (!g.isGranted) revert AccessNotGranted();
        if (!(block.timestamp < g.expiresAt)) revert AccessExpired();
    }

    /**
     * @notice Validate purchase eligibility and open a direct non-escrow access grant.
     * @param dataId Dataset identifier.
     * @param buyer Purchasing researcher address.
     * @param duration License duration in seconds.
     * @return expires Grant expiration timestamp.
     */
    function recordDirectPurchaseGrant(
        uint256 dataId,
        address buyer,
        uint256 duration
    ) external onlyRegistry returns (uint256 expires) {
        if (_isGrantActive(accessGrants[dataId][buyer])) revert AccessAlreadyActive();
        _clearSettledEscrow(dataId, buyer);
        return _setGrant(dataId, buyer, duration);
    }

    /**
     * @notice Prepare and record a complimentary owner-issued direct access grant.
     * @param dataId Dataset identifier.
     * @param recipient Granted researcher address.
     * @param duration License duration in seconds.
     * @return expires Grant expiration timestamp.
     * @return shouldCount True if this is the first counted direct grant for an inactive recipient.
     */
    function recordComplimentaryGrant(
        uint256 dataId,
        address recipient,
        uint256 duration
    ) external onlyRegistry returns (uint256 expires, bool shouldCount) {
        bool wasActive = _isGrantActive(accessGrants[dataId][recipient]);
        bool hadValidBuyer = hasValidBuyerGrant(dataId, recipient);
        if (!wasActive) _clearSettledEscrow(dataId, recipient);
        else if (_isEscrowPending(escrowDeposits[dataId][recipient])) revert EscrowAlreadyActive();
        shouldCount = !_directGrantCounted[dataId][recipient] && !hadValidBuyer;
        if (shouldCount) _directGrantCounted[dataId][recipient] = true;
        expires = _setGrant(dataId, recipient, duration);
    }

    /**
     * @notice Open a new timelocked escrow deposit record.
     * @param dataId Dataset identifier.
     * @param buyer Purchasing buyer address.
     * @param seller Current NFT owner address.
     * @param totalPrice Escrowed price in $GENO wei.
     * @param disputeWindow Seller delivery / buyer dispute window in seconds.
     * @param accessDuration Dataset access duration in seconds.
     */
    function openEscrow(
        uint256 dataId,
        address buyer,
        address seller,
        uint256 totalPrice,
        uint256 disputeWindow,
        uint256 accessDuration
    ) external onlyRegistry {
        if (_isGrantActive(accessGrants[dataId][buyer])) revert AccessAlreadyActive();
        EscrowDeposit storage dep = escrowDeposits[dataId][buyer];
        if (_isEscrowPending(dep)) {
            if (dep.capsuleDelivered && block.timestamp < dep.depositTime + accessDuration) {
                revert AccessAlreadyActive();
            }
            revert EscrowAlreadyActive();
        }
        if (disputeWindow < 1 hours || disputeWindow > 30 days) revert InvalidDisputeWindow();

        _clearBuyerCapsule(dataId, buyer);
        delete accessGrants[dataId][buyer];

        dep.buyer = buyer;
        dep.seller = seller;
        dep.amount = totalPrice;
        dep.depositTime = block.timestamp;
        dep.disputeWindow = disputeWindow;
        dep.released = false;
        dep.refunded = false;
        dep.capsuleDelivered = false;
        _escrowPausedBase[dataId][buyer] = _pauseState[dataId].pausedSeconds;
        _resetEscrowFlags(dataId, buyer);
    }

    /**
     * @notice Toggle buyer +7-day manual release extension (enforces H-01B Active-only symmetry).
     * @param dataId Dataset identifier.
     * @param buyer Calling buyer address.
     * @param manual True to add +7d hold, false to clear while Active.
     */
    function setManualRelease(uint256 dataId, address buyer, bool manual) external onlyRegistry {
        EscrowDeposit storage dep = _requireActiveEscrow(dataId, buyer);
        if (escrowDisputed[dataId][buyer]) revert EscrowDisputedError();
        uint256 deadline = dep.capsuleDelivered
            ? _escrowLockDeadline(dep, dataId, buyer, false)
            : dep.depositTime + dep.disputeWindow;
        if (manual && !(block.timestamp < deadline)) {
            revert DisputeWindowExpired();
        }
        manualEscrowRelease[dataId][buyer] = manual;
    }

    /**
     * @notice Freeze a delivered escrow deposit under buyer dispute for governance arbitration.
     * @param dataId Dataset identifier.
     * @param buyer Disputing buyer address.
     */
    function dispute(uint256 dataId, address buyer) external onlyRegistry {
        EscrowDeposit storage dep = _requireDeliveredUndisputed(dataId, buyer);
        if (!(block.timestamp < _escrowLockDeadline(dep, dataId, buyer, true))) revert DisputeWindowExpired();
        escrowDisputed[dataId][buyer] = true;
        escrowDisputedAt[dataId][buyer] = block.timestamp;
        accessGrants[dataId][buyer].isGranted = false;
    }

    function _finalizeRelease(
        uint256 dataId,
        address buyer,
        bool isRevoked,
        uint256 accessDuration
    ) internal returns (bool settled, address seller, uint256 amount) {
        EscrowDeposit storage dep = escrowDeposits[dataId][buyer];
        if (!_isEscrowPending(dep)) return (false, address(0), 0);
        _resetEscrowFlags(dataId, buyer);
        seller = dep.seller;
        amount = dep.amount;
        dep.released = true;
        if (!isRevoked) {
            AccessGrant storage grant = accessGrants[dataId][buyer];
            if (grant.grantedAt == 0) _setGrant(dataId, buyer, accessDuration);
            else if (!grant.isGranted) grant.isGranted = true;
        }
        settled = true;
    }

    function _finalizeRefund(uint256 dataId, address buyer) internal returns (uint256 refundAmount) {
        EscrowDeposit storage dep = escrowDeposits[dataId][buyer];
        refundAmount = dep.amount;
        dep.refunded = true;
        _resetEscrowFlags(dataId, buyer);
        _clearBuyerCapsule(dataId, buyer);
        delete accessGrants[dataId][buyer];
    }

    /**
     * @notice Buyer confirms capsule receipt and settles escrow immediately.
     * @param dataId Dataset identifier.
     * @param buyer Confirming buyer address.
     * @param isRevoked True if dataset is Revoked.
     * @param accessDuration Dataset access duration in seconds.
     * @return settled True if pending escrow transitioned to released.
     * @return seller Recorded escrow seller address.
     * @return amount Escrowed amount in $GENO wei.
     */
    function confirmAndRelease(
        uint256 dataId,
        address buyer,
        bool isRevoked,
        uint256 accessDuration
    ) external onlyRegistry returns (bool settled, address seller, uint256 amount) {
        _requireDeliveredUndisputed(dataId, buyer);
        return _finalizeRelease(dataId, buyer, isRevoked, accessDuration);
    }

    /**
     * @notice Release escrowed funds to seller after lock deadline or directly by buyer.
     * @param dataId Dataset identifier.
     * @param buyer Buyer address.
     * @param caller Transaction sender on GenomicsRegistry.
     * @param nftOwner Current ERC-721 owner address.
     * @param statusNum Current DataStatus numeric value (0=Active, 1=Paused, 2=Revoked).
     * @param accessDuration Dataset access duration in seconds.
     * @return settled True if pending escrow transitioned to released.
     * @return seller Recorded escrow seller address.
     * @return amount Escrowed amount in $GENO wei.
     */
    function release(
        uint256 dataId,
        address buyer,
        address caller,
        address nftOwner,
        uint8 statusNum,
        uint256 accessDuration
    ) external onlyRegistry returns (bool settled, address seller, uint256 amount) {
        EscrowDeposit storage dep = _requireDeliveredUndisputed(dataId, buyer);
        if (caller != buyer) {
            if (block.timestamp < _escrowLockDeadline(dep, dataId, buyer, true)) {
                if (statusNum != 0) revert DataNotActive();
                revert DisputeWindowActive();
            }
            if (caller != dep.seller && caller != nftOwner) revert NotDataOwner();
        }
        return _finalizeRelease(dataId, buyer, statusNum == 2, accessDuration);
    }

    /**
     * @notice Validate eligibility and finalize a 100% buyer escrow refund.
     * @param dataId Dataset identifier.
     * @param buyer Claiming buyer address.
     * @param statusNum Current DataStatus numeric value (0=Active, 1=Paused, 2=Revoked).
     * @return refundAmount Refunded amount in $GENO wei.
     */
    function claimRefund(
        uint256 dataId,
        address buyer,
        uint8 statusNum
    ) external onlyRegistry returns (uint256 refundAmount) {
        EscrowDeposit storage dep = escrowDeposits[dataId][buyer];
        if (dep.amount == 0 || dep.refunded) revert EscrowNotActive();
        if (dep.released) revert CapsuleAlreadyDelivered();

        if (dep.capsuleDelivered) {
            if (statusNum == 0 || !(block.timestamp < _escrowLockDeadline(dep, dataId, buyer, true))) {
                revert CapsuleAlreadyDelivered();
            }
            if (statusNum == 1) _requireStuckPausedEligible(dep, dataId, buyer);
        }
        if (escrowDisputed[dataId][buyer]) revert EscrowDisputedError();
        if (!dep.capsuleDelivered && statusNum == 0 && block.timestamp < dep.depositTime + dep.disputeWindow) {
            revert DisputeWindowActive();
        }
        return _finalizeRefund(dataId, buyer);
    }

    function _requireStuckPausedEligible(EscrowDeposit storage dep, uint256 dataId, address buyer) internal view {
        PauseState storage ps = _pauseState[dataId];
        uint256 base = _escrowPausedBase[dataId][buyer];
        uint256 w = dep.disputeWindow;
        uint256 curPause;
        uint256 cumPause;
        uint256 wPlusGrace;
        unchecked {
            curPause = ps.pausedAt > 0 ? block.timestamp - ps.pausedAt : 0;
            cumPause = (ps.pausedSeconds > base ? ps.pausedSeconds - base : 0) + curPause;
            wPlusGrace = w + 15 minutes;
        }
        if (
            cumPause < w ||
            block.timestamp < _baseEscrowLockDeadline(dep, dataId, buyer) ||
            (curPause < 15 minutes && cumPause < wPlusGrace)
        ) {
            revert CapsuleAlreadyDelivered();
        }
    }

    /**
     * @notice Governance resolution of a disputed escrow deposit.
     * @param dataId Dataset identifier.
     * @param buyer Disputing buyer address.
     * @param refundBuyer True to refund buyer 100%, false to settle to seller.
     * @param isRevoked True if dataset is Revoked.
     * @param accessDuration Dataset access duration in seconds.
     * @return seller Recorded escrow seller address.
     * @return amount Settled or refunded amount in $GENO wei.
     */
    function resolveDispute(
        uint256 dataId,
        address buyer,
        bool refundBuyer,
        bool isRevoked,
        uint256 accessDuration
    ) external onlyRegistry returns (address seller, uint256 amount) {
        EscrowDeposit storage dep = _requireActiveEscrow(dataId, buyer);
        if (!escrowDisputed[dataId][buyer]) revert EscrowNotDisputed();
        if (refundBuyer) {
            return (dep.seller, _finalizeRefund(dataId, buyer));
        }
        (, seller, amount) = _finalizeRelease(dataId, buyer, isRevoked, accessDuration);
    }

    /**
     * @notice Unilateral buyer refund after DISPUTE_ARBITRATION_TIMEOUT (30 days) elapses on a disputed escrow.
     * @param dataId Dataset identifier.
     * @param buyer Disputing buyer address.
     * @return refundAmount Refunded amount in $GENO wei.
     */
    function claimDisputeTimeout(uint256 dataId, address buyer) external onlyRegistry returns (uint256 refundAmount) {
        _requireActiveEscrow(dataId, buyer);
        if (!escrowDisputed[dataId][buyer]) revert EscrowNotDisputed();
        if (block.timestamp < escrowDisputedAt[dataId][buyer] + DISPUTE_ARBITRATION_TIMEOUT) {
            revert DisputeArbitrationActive();
        }
        return _finalizeRefund(dataId, buyer);
    }

    /**
     * @notice Record pause-blackout timing updates when a dataset transitions Active <-> Paused/Revoked.
     * @param dataId Dataset identifier.
     * @param oldStatus Previous DataStatus numeric code.
     * @param newStatus Target DataStatus numeric code.
     */
    function onStatusTransition(uint256 dataId, uint8 oldStatus, uint8 newStatus) external onlyRegistry {
        PauseState storage ps = _pauseState[dataId];
        if (oldStatus == 0 && newStatus != 0) {
            ps.pausedAt = block.timestamp;
        } else if (oldStatus == 1 && newStatus == 0) {
            uint256 pa = ps.pausedAt;
            if (pa > 0) {
                uint256 dur = block.timestamp - pa;
                ps.pausedSeconds += dur;
                ps.graceCutoff = (ps.lastUnpausedAt > 0 && pa < ps.lastUnpausedAt + 15 minutes)
                    ? ps.graceCutoff + dur
                    : block.timestamp;
                ps.lastUnpausedAt = block.timestamp;
                ps.pausedAt = 0;
            }
        }
    }

    function _validateDeliveryContext(
        uint256 dataId,
        address researcher
    ) internal view returns (bool isPendingEscrow, uint256 deadline) {
        EscrowDeposit storage dep = escrowDeposits[dataId][researcher];
        if (dep.amount > 0) {
            if (dep.refunded) revert EscrowNotActive();
            if (dep.released) {
                if (!hasValidBuyerGrant(dataId, researcher)) revert EscrowNotActive();
            } else {
                if (escrowDisputed[dataId][researcher]) revert EscrowDisputedError();
                deadline = dep.capsuleDelivered
                    ? _escrowLockDeadline(dep, dataId, researcher, true)
                    : dep.depositTime + dep.disputeWindow;
                if (!(block.timestamp < deadline)) revert DisputeWindowExpired();
                isPendingEscrow = true;
            }
        } else {
            _requireActiveGrant(dataId, researcher);
        }
    }

    function _applyEscrowDeliveryWindow(
        uint256 dataId,
        address researcher,
        uint256 deadline,
        bool sameCapsule,
        uint256 accessDuration
    ) internal {
        EscrowDeposit storage dep = escrowDeposits[dataId][researcher];
        if (!dep.capsuleDelivered) {
            if (block.timestamp + 15 minutes > deadline) {
                dep.disputeWindow = (block.timestamp - dep.depositTime) + 15 minutes;
            }
            _setGrant(dataId, researcher, accessDuration);
            dep.capsuleDelivered = true;
        } else if (!sameCapsule && block.timestamp + 15 minutes > deadline) {
            uint256 psSec = _pauseState[dataId].pausedSeconds;
            uint256 pBase = _escrowPausedBase[dataId][researcher];
            uint256 rawOffset = _baseEscrowLockDeadline(dep, dataId, researcher) -
                dep.disputeWindow +
                (psSec > pBase ? psSec - pBase : 0);
            uint256 newWindow = (block.timestamp + 15 minutes) - rawOffset;
            uint256 maxWindow = 30 days + 15 minutes;
            if (newWindow > maxWindow) newWindow = maxWindow;
            if (newWindow > dep.disputeWindow) dep.disputeWindow = newWindow;
        }
    }

    /**
     * @notice Validate capsule, enforce rotation/idempotency, persist capsule, and activate pending escrow grant.
     * @param dataId Dataset identifier.
     * @param researcher Recipient researcher address.
     * @param capsule Serialized RSA-OAEP JSON key capsule.
     * @param accessDuration Dataset access duration in seconds.
     * @param currentKeyHash Keccak-256 hash of researcher's registered public key.
     * @param hasPublicKey True if researcher registered a non-empty public key.
     * @param allowIdempotent True when called via `emitTransformedCapsule`.
     * @return newCapsuleHash Keccak-256 digest of the delivered capsule.
     */
    function deliverCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule,
        uint256 accessDuration,
        bytes32 currentKeyHash,
        bool hasPublicKey,
        bool allowIdempotent
    ) external onlyRegistry returns (bytes32 newCapsuleHash) {
        if (bytes(capsule).length == 0) revert EmptyCapsule();
        (bool isPendingEscrow, uint256 deadline) = _validateDeliveryContext(dataId, researcher);
        if (!GENOMIC_NFT.validateCapsule(capsule)) revert InvalidCapsuleFormat();

        newCapsuleHash = keccak256(bytes(capsule));
        bytes32 prevCapsuleHash = _buyerCapsuleHash[dataId][researcher];
        bool sameCapsule = prevCapsuleHash == newCapsuleHash;

        if (prevCapsuleHash != bytes32(0)) {
            bool idempotentEmit = sameCapsule && allowIdempotent;
            if (!idempotentEmit && (!hasPublicKey || currentKeyHash == _capsuleDeliveryKeyHash[dataId][researcher])) {
                revert CapsuleAlreadyDelivered();
            }
        }
        if (isPendingEscrow) _applyEscrowDeliveryWindow(dataId, researcher, deadline, sameCapsule, accessDuration);
        if (!sameCapsule) {
            _capsuleDeliveryKeyHash[dataId][researcher] = currentKeyHash;
            _buyerCapsuleHash[dataId][researcher] = newCapsuleHash;
            _buyerCapsules[dataId][researcher] = capsule;
        }
    }

    /**
     * @notice Return effective pause-adjusted escrow lock deadline or 0 if no pending deposit exists.
     * @param dataId Dataset identifier.
     * @param buyer Buyer address.
     * @return deadline Effective Unix timestamp deadline, or 0.
     */
    function getEscrowLockDeadline(uint256 dataId, address buyer) external view returns (uint256 deadline) {
        EscrowDeposit storage dep = escrowDeposits[dataId][buyer];
        if (!_isEscrowPending(dep)) return 0;
        if (!dep.capsuleDelivered) return dep.depositTime + dep.disputeWindow;
        return _escrowLockDeadline(dep, dataId, buyer, true);
    }

    /**
     * @notice Check whether a buyer holds a non-disputed, delivered, unexpired license grant.
     * @param dataId Dataset identifier.
     * @param user Buyer address.
     * @return valid True if active access is granted.
     */
    function hasValidBuyerGrant(uint256 dataId, address user) public view returns (bool valid) {
        if (escrowDisputed[dataId][user]) return false;
        EscrowDeposit storage dep = escrowDeposits[dataId][user];
        if (dep.amount > 0 && (dep.refunded || !dep.capsuleDelivered)) return false;
        return _isGrantActive(accessGrants[dataId][user]);
    }

    /**
     * @notice Revert with specific access error if buyer does not hold active undisputed access.
     * @param dataId Dataset identifier.
     * @param user Buyer address.
     */
    function requireBuyerActiveAccess(uint256 dataId, address user) external view {
        if (escrowDisputed[dataId][user]) revert EscrowDisputedError();
        EscrowDeposit storage dep = escrowDeposits[dataId][user];
        if (dep.amount > 0 && (dep.refunded || !dep.capsuleDelivered)) revert AccessNotGranted();
        _requireActiveGrant(dataId, user);
    }

    /**
     * @notice Unified capsule getter restricted strictly to GenomicsRegistry (`onlyRegistry`),
     *         enforcing INVARIANT-16 lifecycle and caller authorization symmetry so no external
     *         caller can bypass GenomicsRegistry's Active status or role checks.
     * @param dataId Dataset identifier.
     * @param user Researcher address.
     * @param mode 0 = unauthorized (empty string), 1 = buyer verified (reverts on inactive/disputed), 2 = owner/worker.
     * @return capsule Serialized RSA-OAEP JSON key capsule or empty string.
     */
    function getBuyerCapsuleByMode(
        uint256 dataId,
        address user,
        uint8 mode
    ) external view onlyRegistry returns (string memory capsule) {
        if (mode == 0) return "";
        if (mode == 1) {
            if (escrowDisputed[dataId][user]) revert EscrowDisputedError();
            EscrowDeposit storage dep = escrowDeposits[dataId][user];
            if (dep.amount > 0 && (dep.refunded || !dep.capsuleDelivered)) revert AccessNotGranted();
            _requireActiveGrant(dataId, user);
            return _buyerCapsules[dataId][user];
        }
        return hasValidBuyerGrant(dataId, user) ? _buyerCapsules[dataId][user] : "";
    }
}