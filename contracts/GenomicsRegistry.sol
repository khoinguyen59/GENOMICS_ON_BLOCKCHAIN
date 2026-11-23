// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { GenomicNFT } from "./GenomicNFT.sol";
import { GenomicsMetadataStore } from "./registry/GenomicsMetadataStore.sol";
import { GenomicsEscrowEngine } from "./registry/GenomicsEscrowEngine.sol";
import { GenomicsRegistryStorage } from "./registry/GenomicsRegistryStorage.sol";

/**
 * @title GenomicsRegistry
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Core registry contract for managing genomic data registration, access granting with timelocked
 *         escrow, status updates, and active on-chain disbursement of EIP-2981 royalties via royaltyInfo().
 * @dev Non-custodial auxiliary modules (GenomicsMetadataStore & GenomicsEscrowEngine) are deployed in
 *      the constructor with strict `onlyRegistry` access control and zero delegatecall surface. All
 *      $GENO token custody and EIP-2981 settlement stay exclusively in GenomicsRegistry, while providing
 *      generous EIP-170 headroom at production optimizer runs and 100% zero-arg factory compatibility.
 */
contract GenomicsRegistry is GenomicsRegistryStorage {
    using SafeERC20 for IERC20;

    uint256 private constant _REENTRANCY_GUARD_SLOT = 1;

    IERC20 private immutable PAYMENT_TOKEN;
    GenomicNFT private immutable GENOMIC_NFT;
    GenomicsMetadataStore private immutable METADATA_STORE;
    GenomicsEscrowEngine private immutable ESCROW_ENGINE;

    /// @notice Thrown on nested reentrant calls protected by EIP-1153 transient storage.
    error ReentrancyGuardReentrantCall();
    /// @notice Thrown when caller is neither current NFT owner nor an authorized dispatcher/worker.
    error NotDataOwner();
    /// @notice Thrown when an operation requires DataStatus.Active.
    error DataNotActive();
    /// @notice Thrown when the current NFT owner attempts to buy their own dataset.
    error OwnerCannotBuyOwnData();
    /// @notice Thrown when dataId is zero or exceeds dataCount.
    error DataNotFound();
    /// @notice Thrown when rawDataHash or tokenUri/CID validation fails.
    error InvalidDataHashOrCid();
    /// @notice Thrown when rawDataHash has already been registered (anti-clone).
    error DataAlreadyRegistered();
    /// @notice Thrown when a zero or invalid recipient/contract address is provided.
    error InvalidRecipient();
    /// @notice Thrown when a zero address is passed for buyer, researcher, or rescued token.
    error InvalidAddress();
    /// @notice Thrown if minted NFT tokenId unexpectedly mismatches predicted nextTokenId.
    error TokenIdMismatch();
    /// @notice Thrown when mutating a permanently revoked dataset.
    error ConsentPermanentlyRevoked();
    /// @notice Thrown when a data owner attempts to grant direct access or study reuse to themselves.
    error SelfAccessNotAllowed();
    /// @notice Thrown when current dataset price or reuse fee exceeds buyer's MEV slippage cap `maxPrice`.
    /// @param currentPrice Current on-chain price or fee in $GENO wei.
    /// @param maxPrice Caller's maximum acceptable amount in $GENO wei.
    error PriceExceedsMax(uint256 currentPrice, uint256 maxPrice);
    /// @notice Thrown when governance attempts to rescue escrowed paymentToken balances.
    error CannotRescuePaymentToken();

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    modifier onlyDataOwner(uint256 dataId) {
        _checkDataOwner(dataId);
        _;
    }

    modifier onlyMutableDataOwner(uint256 dataId) {
        _checkMutableDataOwner(dataId);
        _;
    }

    modifier onlyDataOwnerOrDispatcher(uint256 dataId) {
        _checkDataOwnerOrDispatcher(dataId);
        _;
    }

    /**
     * @notice Deploy GenomicsRegistry linked to `$GENO` and `GenomicNFT` and initialize its child modules.
     * @param _paymentToken Address of the ERC-20 $GENO payment token.
     * @param _genomicNFT Address of the ERC-721 / EIP-2981 GenomicNFT contract.
     * @param initialOwner Initial governance owner and default capsule dispatcher.
     */
    constructor(
        address _paymentToken,
        address _genomicNFT,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_paymentToken == address(0) || _genomicNFT == address(0) || initialOwner == address(0)) {
            revert InvalidRecipient();
        }
        PAYMENT_TOKEN = IERC20(_paymentToken);
        GENOMIC_NFT = GenomicNFT(_genomicNFT);
        METADATA_STORE = new GenomicsMetadataStore(_genomicNFT);
        ESCROW_ENGINE = new GenomicsEscrowEngine(_genomicNFT);
        capsuleDispatcher = initialOwner;
    }

    /**
     * @notice Return the immutable ERC-20 $GENO payment token.
     * @return token ERC-20 payment token contract.
     */
    function paymentToken() external view returns (IERC20 token) {
        return PAYMENT_TOKEN;
    }

    /**
     * @notice Return the immutable GenomicNFT contract.
     * @return nft ERC-721 / EIP-2981 GenomicNFT contract.
     */
    function genomicNFT() external view returns (GenomicNFT nft) {
        return GENOMIC_NFT;
    }

    /**
     * @notice Return the immutable child GenomicsMetadataStore address.
     * @return store Address of the deployed GenomicsMetadataStore contract.
     */
    function metadataStore() external view returns (address store) {
        return address(METADATA_STORE);
    }

    /**
     * @notice Return the immutable child GenomicsEscrowEngine address.
     * @return engine Address of the deployed GenomicsEscrowEngine contract.
     */
    function escrowEngine() external view returns (address engine) {
        return address(ESCROW_ENGINE);
    }

    // =========================================================================
    // ABI-Compatible Delegated Views (Zero-Copy Immutable Staticcall Forwarding)
    // =========================================================================

    function _staticForward(address target) internal view {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := staticcall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    function _staticForwardRaw(address target, bytes memory payload) internal view {
        assembly {
            let ok := staticcall(gas(), target, add(payload, 32), mload(payload), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /**
     * @notice Retrieve an active or historical AccessGrant record for `(dataId, researcher)`.
     * @param dataId Dataset identifier.
     * @param researcher Researcher wallet address.
     * @return isGranted True if license is currently enabled.
     * @return grantedAt Grant start timestamp.
     * @return expiresAt Grant expiration timestamp.
     */
    function accessGrants(uint256 dataId, address researcher)
        external
        view
        returns (bool isGranted, uint256 grantedAt, uint256 expiresAt)
    {
        return ESCROW_ENGINE.accessGrants(dataId, researcher);
    }

    /**
     * @notice Retrieve the packed EscrowDeposit record for `(dataId, buyerAddr)`.
     * @param dataId Dataset identifier.
     * @param buyerAddr Buyer wallet address.
     * @return buyer Buyer address.
     * @return released True if settled to seller.
     * @return refunded True if refunded to buyer.
     * @return capsuleDelivered True if seller/dispatcher delivered key capsule.
     * @return seller Seller address recorded at deposit time.
     * @return amount Escrowed amount in $GENO wei.
     * @return depositTime Escrow deposit timestamp.
     * @return disputeWindow Delivery / dispute window duration in seconds.
     */
    function escrowDeposits(uint256 dataId, address buyerAddr)
        external
        view
        returns (
            address buyer,
            bool released,
            bool refunded,
            bool capsuleDelivered,
            address seller,
            uint256 amount,
            uint256 depositTime,
            uint256 disputeWindow
        )
    {
        return ESCROW_ENGINE.escrowDeposits(dataId, buyerAddr);
    }

    /**
     * @notice Check whether an escrow deposit is currently frozen under dispute.
     * @return True if disputed.
     */
    function escrowDisputed(uint256, address) external view returns (bool) {
        _staticForward(address(ESCROW_ENGINE));
    }

    /**
     * @notice Return the timestamp when a post-delivery escrow dispute was opened.
     * @return Dispute timestamp, or 0.
     */
    function escrowDisputedAt(uint256, address) external view returns (uint256) {
        _staticForward(address(ESCROW_ENGINE));
    }

    /**
     * @notice Check whether a buyer enabled the +7-day manual escrow release extension.
     * @return True if manual release extension is enabled.
     */
    function manualEscrowRelease(uint256, address) external view returns (bool) {
        _staticForward(address(ESCROW_ENGINE));
    }

    /**
     * @notice Retrieve a researcher's registered RSA-OAEP public key string.
     * @return Serialized JWK or SPKI public key string.
     */
    function researcherPublicKeys(address) external view returns (string memory) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return the current O(1) worker authorization revocation epoch for a dataset.
     * @return Current monotonic worker epoch.
     */
    function workerEpoch(uint256) external view returns (uint256) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return the anchored SHA-256 hash of a dataset's encrypted clinical summary PDF.
     * @return Anchored SHA-256 hash.
     */
    function summaryDataHashes(uint256) external view returns (bytes32) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return the anchored SHA-256 hash of a dataset's public GA4GH Phenopacket JSON.
     * @return Anchored SHA-256 hash.
     */
    function metadataHashes(uint256) external view returns (bytes32) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return the number of blinded trait tags registered on a dataset.
     * @return Registered blind tag count.
     */
    function datasetBlindTagCount(uint256) external view returns (uint256) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return the commit block number for a salted registration commitment key.
     * @return Block number recorded for the commitment, or 0 if absent.
     */
    function registrationCommitments(bytes32) external view returns (uint256) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Check whether strict commit-reveal registration mode is currently required.
     * @return True if commit-reveal is mandatory.
     */
    function commitRevealRequired() external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Check whether a study commitment receipt has been recorded for a dataset.
     * @dev Intentionally unique across all buyers per `dataId` to prevent cross-buyer study receipt replay;
     *      off-chain callers should bind researcher address into the preimage.
     * @return True if recorded.
     */
    function studyReuseReceipts(uint256, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Return cumulative count of settled follow-on study reuses for a dataset.
     * @return Reuse count.
     */
    function datasetReuseCount(uint256) external view returns (uint256) {
        _staticForward(address(METADATA_STORE));
    }

    // =========================================================================
    // Internal Guards
    // =========================================================================

    function _nonReentrantBefore() internal {
        uint256 entered;
        assembly {
            entered := tload(_REENTRANCY_GUARD_SLOT)
        }
        if (entered != 0) revert ReentrancyGuardReentrantCall();
        assembly {
            tstore(_REENTRANCY_GUARD_SLOT, 1)
        }
    }

    function _nonReentrantAfter() internal {
        assembly {
            tstore(_REENTRANCY_GUARD_SLOT, 0)
        }
    }

    function _requireValidDataId(uint256 dataId) internal view {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
    }

    struct ItemMeta {
        address currentOwner;
        DataStatus status;
        uint256 tokenId;
        uint256 price;
        uint256 accessDuration;
    }

    function _core(uint256 dataId) internal view returns (ItemMeta memory m) {
        (m.tokenId, m.currentOwner, m.price, m.accessDuration, m.status) = METADATA_STORE.getItemMeta(dataId);
    }

    function _requireActiveData(uint256 dataId) internal view returns (ItemMeta memory core) {
        core = _core(dataId);
        if (core.status != DataStatus.Active) revert DataNotActive();
    }

    function _ownerOf(uint256 tokenId) internal view returns (address) {
        return GENOMIC_NFT.ownerOf(tokenId);
    }

    function _checkDataOwner(uint256 dataId) internal view {
        _requireValidDataId(dataId);
        if (msg.sender != _ownerOf(_core(dataId).tokenId)) revert NotDataOwner();
    }

    function _checkMutableDataOwner(uint256 dataId) internal view {
        _requireValidDataId(dataId);
        ItemMeta memory core = _core(dataId);
        if (msg.sender != _ownerOf(core.tokenId)) revert NotDataOwner();
        if (!(uint8(core.status) < uint8(DataStatus.Revoked))) revert ConsentPermanentlyRevoked();
    }

    function _isDispatcherOrWorker(uint256 dataId, address caller) internal view returns (bool) {
        return (caller == capsuleDispatcher && !dispatcherDisabled[dataId]) || METADATA_STORE.isAuthorizedWorker(dataId, caller);
    }

    function _checkDataOwnerOrDispatcher(uint256 dataId) internal view {
        _requireValidDataId(dataId);
        if (msg.sender != _ownerOf(_core(dataId).tokenId) && !_isDispatcherOrWorker(dataId, msg.sender)) {
            revert NotDataOwner();
        }
    }

    function _safeOwnerOf(uint256 tokenId, address fallbackOwner) internal view returns (address) {
        (bool ok, bytes memory data) = address(GENOMIC_NFT).staticcall(
            abi.encodeWithSelector(0x6352211e, tokenId)
        );
        if (ok && data.length == 32) return abi.decode(data, (address));
        return fallbackOwner;
    }

    // =========================================================================
    // Registration & Commit-Reveal
    // =========================================================================

    /**
     * @notice Toggle strict commit-reveal registration mode to block mempool front-running.
     * @param required True to require prior commitGenomicData() before register calls.
     */
    function setCommitRevealRequired(bool required) external onlyOwner {
        METADATA_STORE.setCommitRevealRequired(required);
        emit CommitRevealRequirementUpdated(required);
    }

    /**
     * @notice Submit salted commitment `keccak256(abi.encodePacked(rawDataHash, salt, msg.sender))`.
     * @param commitment Salted hash commitment binding rawDataHash, salt, and msg.sender.
     */
    function commitGenomicData(bytes32 commitment) external {
        uint256 blockNum = METADATA_STORE.commitGenomicData(commitment, msg.sender);
        emit GenomicDataCommitted(commitment, msg.sender, blockNum);
    }

    /**
     * @notice Reveal salted commitment in a later block and register encrypted genomic dataset.
     * @param rawDataHash SHA-256 hash of encrypted raw package (`IV || Ciphertext`).
     * @param salt Random 32-byte blinding salt used during commitment.
     * @param cidsAndUri Array `[rawCid, summaryCid, metadataCid, tokenUri]`.
     * @param price License price in $GENO wei.
     * @param accessDuration License duration in seconds (1..365 days).
     * @param royaltyBps EIP-2981 royalty basis points (0..5000).
     * @return dataId Newly assigned dataset identifier.
     */
    function revealAndRegisterGenomicData(
        bytes32 rawDataHash,
        bytes32 salt,
        string[4] calldata cidsAndUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) external nonReentrant returns (uint256 dataId) {
        METADATA_STORE.consumeCommitment(rawDataHash, salt, msg.sender);
        dataId = _registerDirect(
            rawDataHash,
            cidsAndUri[0],
            cidsAndUri[1],
            cidsAndUri[2],
            cidsAndUri[3],
            price,
            accessDuration,
            royaltyBps
        );
    }

    /**
     * @notice Reveal salted commitment and register full 3-hash + blind-tag genomic dataset bundle.
     * @param hashes Array `[rawDataHash, summaryHash, metadataHash]`.
     * @param salt Random 32-byte blinding salt used during commitment.
     * @param cidsAndUri Array `[rawCid, summaryCid, metadataCid, tokenUri]`.
     * @param priceInGeno License price in $GENO wei.
     * @param accessDurationSeconds License duration in seconds (1..365 days).
     * @param royaltyBps EIP-2981 royalty basis points (0..5000).
     * @param blindTags Unique non-zero blinded trait search tags (max 16).
     * @return newDataId Newly assigned dataset identifier.
     */
    function revealAndRegisterGenomicDataBundle(
        bytes32[3] calldata hashes,
        bytes32 salt,
        string[4] calldata cidsAndUri,
        uint256 priceInGeno,
        uint256 accessDurationSeconds,
        uint96 royaltyBps,
        bytes32[] calldata blindTags
    ) external nonReentrant returns (uint256 newDataId) {
        METADATA_STORE.consumeCommitment(hashes[0], salt, msg.sender);
        newDataId = _registerBundleInternal(hashes, cidsAndUri, priceInGeno, accessDurationSeconds, royaltyBps, blindTags);
    }

    /**
     * @notice Register an encrypted genomic dataset on-chain and mint its GenomicNFT.
     * @param rawDataHash SHA-256 hash of encrypted raw package (`IV || Ciphertext`).
     * @param rawCid IPFS CID of encrypted raw sequence file.
     * @param summaryCid IPFS CID of encrypted clinical summary PDF.
     * @param metadataCid IPFS CID of public GA4GH Phenopacket v2 JSON.
     * @param tokenUri NFT tokenURI string (XSS schemes and control chars rejected).
     * @param price License price in $GENO wei.
     * @param accessDuration License duration in seconds (1..365 days).
     * @param royaltyBps EIP-2981 royalty basis points (0..5000).
     * @return dataId Newly assigned dataset identifier.
     */
    function registerGenomicData(
        bytes32 rawDataHash,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        string calldata tokenUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) external nonReentrant returns (uint256 dataId) {
        METADATA_STORE.requireDirectRegistrationAllowed();
        dataId = _registerDirect(rawDataHash, rawCid, summaryCid, metadataCid, tokenUri, price, accessDuration, royaltyBps);
    }

    /**
     * @notice Register an encrypted genomic dataset with all 3 artifact hashes and blind search tags atomically.
     * @param hashes Array `[rawDataHash, summaryHash, metadataHash]`.
     * @param cidsAndUri Array `[rawCid, summaryCid, metadataCid, tokenUri]`.
     * @param priceInGeno License price in $GENO wei.
     * @param accessDurationSeconds License duration in seconds (1..365 days).
     * @param royaltyBps EIP-2981 royalty basis points (0..5000).
     * @param blindTags Unique non-zero blinded trait search tags (max 16).
     * @return newDataId Newly assigned dataset identifier.
     */
    function registerGenomicDataBundle(
        bytes32[3] calldata hashes,
        string[4] calldata cidsAndUri,
        uint256 priceInGeno,
        uint256 accessDurationSeconds,
        uint96 royaltyBps,
        bytes32[] calldata blindTags
    ) external nonReentrant returns (uint256 newDataId) {
        METADATA_STORE.requireDirectRegistrationAllowed();
        newDataId = _registerBundleInternal(hashes, cidsAndUri, priceInGeno, accessDurationSeconds, royaltyBps, blindTags);
    }

    function _registerBundleInternal(
        bytes32[3] calldata hashes,
        string[4] calldata cidsAndUri,
        uint256 priceInGeno,
        uint256 accessDurationSeconds,
        uint96 royaltyBps,
        bytes32[] calldata blindTags
    ) internal returns (uint256 newDataId) {
        if (hashes[1] == bytes32(0) || hashes[2] == bytes32(0)) revert InvalidDataHashOrCid();
        uint256 expectedTokenId;
        (newDataId, expectedTokenId) = _initData(hashes[0], cidsAndUri[3], priceInGeno, accessDurationSeconds);
        METADATA_STORE.anchorArtifactHashes(newDataId, hashes[1], hashes[2], false);
        emit ArtifactHashesAnchored(newDataId, hashes[1], hashes[2]);
        if (blindTags.length > 0) _setBlindTagsInternal(newDataId, blindTags);
        _mintNft(
            newDataId,
            expectedTokenId,
            hashes[0],
            priceInGeno,
            cidsAndUri[0],
            cidsAndUri[1],
            cidsAndUri[2],
            cidsAndUri[3],
            royaltyBps
        );
    }

    function _registerDirect(
        bytes32 rawDataHash,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        string calldata tokenUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) internal returns (uint256 dataId) {
        uint256 expectedTokenId;
        (dataId, expectedTokenId) = _initData(rawDataHash, tokenUri, price, accessDuration);
        _mintNft(dataId, expectedTokenId, rawDataHash, price, rawCid, summaryCid, metadataCid, tokenUri, royaltyBps);
    }

    function _initData(
        bytes32 rawDataHash,
        string calldata tokenUri,
        uint256 price,
        uint256 accessDuration
    ) internal returns (uint256 newDataId, uint256 expectedTokenId) {
        if (rawDataHash == bytes32(0) || bytes(tokenUri).length == 0) revert InvalidDataHashOrCid();
        if (registeredRawDataHashes[rawDataHash]) revert DataAlreadyRegistered();

        registeredRawDataHashes[rawDataHash] = true;
        expectedTokenId = GENOMIC_NFT.nextTokenId();
        newDataId = ++dataCount;
        tokenToDataId[expectedTokenId] = newDataId;
        METADATA_STORE.createItem(newDataId, expectedTokenId, msg.sender, rawDataHash, price, accessDuration);
    }

    function _mintNft(
        uint256 dataId,
        uint256 expectedTokenId,
        bytes32 rawDataHash,
        uint256 price,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        string calldata tokenUri,
        uint96 royaltyBps
    ) internal {
        uint256 mintedTokenId = GENOMIC_NFT.mintGenomicNFT(
            msg.sender,
            tokenUri,
            rawDataHash,
            rawCid,
            summaryCid,
            metadataCid,
            royaltyBps
        );
        if (mintedTokenId != expectedTokenId) revert TokenIdMismatch();
        emit GenomicDataRegistered(dataId, mintedTokenId, msg.sender, rawDataHash, price, metadataCid);
    }

    // =========================================================================
    // Direct Access & Timelocked Escrow Settlement
    // =========================================================================

    /**
     * @notice Purchase time-locked access directly with EIP-2981 royalty settlement (no slippage cap).
     * @param dataId Target dataset ID to purchase access for.
     */
    function grantAccess(uint256 dataId) external nonReentrant {
        _grantAccessInternal(dataId, type(uint256).max);
    }

    /**
     * @notice Purchase time-locked access directly with MEV slippage protection.
     * @param dataId Target dataset ID to purchase access for.
     * @param maxPrice Maximum price in $GENO wei the buyer is willing to pay.
     */
    function grantAccess(uint256 dataId, uint256 maxPrice) external nonReentrant {
        _grantAccessInternal(dataId, maxPrice);
    }

    function _validatePurchase(
        uint256 dataId,
        uint256 maxPrice
    ) internal view returns (ItemMeta memory data, address seller) {
        _requireValidDataId(dataId);
        data = _requireActiveData(dataId);
        if (data.price > maxPrice) revert PriceExceedsMax(data.price, maxPrice);
        seller = _ownerOf(data.tokenId);
        if (msg.sender == seller) revert OwnerCannotBuyOwnData();
    }

    function _grantAccessInternal(uint256 dataId, uint256 maxPrice) internal {
        (ItemMeta memory data, address seller) = _validatePurchase(dataId, maxPrice);
        uint256 totalPrice = data.price;
        uint256 expires = ESCROW_ENGINE.recordDirectPurchaseGrant(dataId, msg.sender, data.accessDuration);
        METADATA_STORE.adjustAccessCount(dataId, true, seller);
        (, uint256 royaltyAmount) = _settleRoyaltyPayment(dataId, data.tokenId, msg.sender, seller, totalPrice);
        emit AccessGranted(dataId, msg.sender, totalPrice, royaltyAmount, expires);
    }

    /**
     * @notice Purchase access with timelocked escrow protection & dispute refund guarantee.
     * @param dataId Target dataset ID.
     * @param disputeWindow Time window in seconds (1 hour..30 days) for capsule delivery and buyer verification.
     */
    function grantAccessWithEscrow(uint256 dataId, uint256 disputeWindow) external nonReentrant {
        _grantAccessWithEscrowInternal(dataId, disputeWindow, type(uint256).max);
    }

    /**
     * @notice Purchase access with timelocked escrow protection & MEV slippage protection.
     * @param dataId Target dataset ID.
     * @param disputeWindow Time window in seconds (1 hour..30 days) for capsule delivery and buyer verification.
     * @param maxPrice Maximum price in $GENO wei the buyer is willing to pay.
     */
    function grantAccessWithEscrow(uint256 dataId, uint256 disputeWindow, uint256 maxPrice) external nonReentrant {
        _grantAccessWithEscrowInternal(dataId, disputeWindow, maxPrice);
    }

    function _grantAccessWithEscrowInternal(uint256 dataId, uint256 disputeWindow, uint256 maxPrice) internal {
        (ItemMeta memory data, address seller) = _validatePurchase(dataId, maxPrice);
        uint256 totalPrice = data.price;
        ESCROW_ENGINE.openEscrow(dataId, msg.sender, seller, totalPrice, disputeWindow, data.accessDuration);
        METADATA_STORE.adjustAccessCount(dataId, true, seller);
        _transferToken(msg.sender, address(this), totalPrice);
        emit EscrowDeposited(dataId, msg.sender, totalPrice, disputeWindow);
    }

    /**
     * @notice Return the exact on-chain escrow lock deadline (including pause-blackout and manual hold),
     *         or 0 if no pending escrow deposit exists for `(dataId, buyer)`.
     * @param dataId Target dataset ID.
     * @return Effective Unix timestamp lock deadline, or 0 if no pending escrow exists.
     */
    function getEscrowLockDeadline(uint256 dataId, address) external view returns (uint256) {
        _requireValidDataId(dataId);
        _staticForward(address(ESCROW_ENGINE));
    }

    /**
     * @notice Buyer toggles manual confirmation release for their escrow (bounded to MAX_MANUAL_ESCROW_EXTENSION).
     * @dev Strictly requires `DataStatus.Active` for BOTH `manual == true` and `manual == false` (H-01B invariant):
     *      allowing `manual = false` during `Paused` would retroactively shrink `_baseEscrowLockDeadline` and let
     *      a buyer snipe a 100% refund on a delivered capsule mid-pause. Buyers with `manual == true` during `Paused`
     *      may still exit cleanly via `confirmCapsuleAndReleaseEscrow` or `disputeCapsule`.
     * @param dataId Target dataset ID.
     * @param manual True to add +7-day manual confirmation hold, false to remove hold while Active.
     */
    function setManualEscrowRelease(uint256 dataId, bool manual) external {
        _requireValidDataId(dataId);
        _requireActiveData(dataId);
        ESCROW_ENGINE.setManualRelease(dataId, msg.sender, manual);
    }

    /**
     * @notice Dispute a delivered capsule during the active dispute window (freezes escrow for governance arbitration).
     * @param dataId Target dataset ID.
     */
    function disputeCapsule(uint256 dataId) external {
        _requireValidDataId(dataId);
        ESCROW_ENGINE.dispute(dataId, msg.sender);
        emit EscrowDisputed(dataId, msg.sender);
    }

    /**
     * @notice Buyer explicitly confirms satisfactory capsule delivery and releases escrow immediately.
     * @param dataId Target dataset ID.
     */
    function confirmCapsuleAndReleaseEscrow(uint256 dataId) external nonReentrant {
        _requireValidDataId(dataId);
        ItemMeta memory data = _core(dataId);
        (bool settled, address seller, uint256 amount) = ESCROW_ENGINE.confirmAndRelease(
            dataId,
            msg.sender,
            data.status == DataStatus.Revoked,
            data.accessDuration
        );
        emit EscrowConfirmed(dataId, msg.sender);
        if (settled) _finalizeEscrowPayout(dataId, data.tokenId, data.currentOwner, msg.sender, seller, amount);
    }

    /**
     * @notice Claim a 100% refund when capsule is not delivered before dispute window expires
     *         (or dataset is deactivated/stuck-paused past full window).
     * @param dataId Target dataset ID.
     */
    function claimEscrowRefund(uint256 dataId) external nonReentrant {
        _requireValidDataId(dataId);
        ItemMeta memory data = _core(dataId);
        uint256 refundAmount = ESCROW_ENGINE.claimRefund(dataId, msg.sender, uint8(data.status));
        _finalizeEscrowRefund(dataId, msg.sender, refundAmount);
    }

    /**
     * @notice Arbiter governance resolves a post-delivery escrow dispute (100% buyer refund or seller+royalty release).
     * @dev Anti-griefing invariant (CONS-06 / FIX-55d): When `refundBuyer == false`, restoring access preserves original
     *      `grant.expiresAt` so frivolous disputants cannot farm extra license duration.
     * @param dataId Target dataset ID.
     * @param buyer Disputing buyer address.
     * @param refundBuyer True to refund buyer 100%, false to release to seller and creator.
     */
    function resolveEscrowDispute(uint256 dataId, address buyer, bool refundBuyer) external onlyOwner nonReentrant {
        if (buyer == address(0)) revert InvalidAddress();
        _requireValidDataId(dataId);
        ItemMeta memory data = _core(dataId);
        (address seller, uint256 amt) = ESCROW_ENGINE.resolveDispute(
            dataId,
            buyer,
            refundBuyer,
            data.status == DataStatus.Revoked,
            data.accessDuration
        );
        if (refundBuyer) _finalizeEscrowRefund(dataId, buyer, amt);
        else _finalizeEscrowPayout(dataId, data.tokenId, data.currentOwner, buyer, seller, amt);
        emit EscrowDisputeResolved(dataId, buyer, refundBuyer, amt);
    }

    /**
     * @notice Claim a 100% buyer refund if a disputed escrow remains unresolved past DISPUTE_ARBITRATION_TIMEOUT (30 days).
     * @param dataId Target dataset ID.
     */
    function claimDisputeTimeoutRefund(uint256 dataId) external nonReentrant {
        _requireValidDataId(dataId);
        uint256 refundAmount = ESCROW_ENGINE.claimDisputeTimeout(dataId, msg.sender);
        _finalizeEscrowRefund(dataId, msg.sender, refundAmount);
    }

    /**
     * @notice Manually release escrowed payment to seller once capsule is delivered and lock window passes.
     * @param dataId Target dataset ID.
     * @param buyer Buyer address whose escrow is being settled.
     */
    function releaseEscrow(uint256 dataId, address buyer) external nonReentrant {
        _requireValidDataId(dataId);
        ItemMeta memory data = _core(dataId);
        address nftOwner = msg.sender == buyer ? address(0) : _ownerOf(data.tokenId);
        (bool settled, address seller, uint256 amount) = ESCROW_ENGINE.release(
            dataId,
            buyer,
            msg.sender,
            nftOwner,
            uint8(data.status),
            data.accessDuration
        );
        if (settled) _finalizeEscrowPayout(dataId, data.tokenId, data.currentOwner, buyer, seller, amount);
    }

    function _finalizeEscrowRefund(uint256 dataId, address buyer, uint256 refundAmount) internal {
        METADATA_STORE.adjustAccessCount(dataId, false, address(0));
        _transferToken(address(this), buyer, refundAmount);
        emit EscrowRefunded(dataId, buyer, refundAmount);
    }

    function _finalizeEscrowPayout(
        uint256 dataId,
        uint256 tokenId,
        address cachedOwner,
        address buyer,
        address sellerAddr,
        uint256 totalPrice
    ) internal {
        address liveOwner = _safeOwnerOf(tokenId, cachedOwner);
        address seller = sellerAddr != address(0) ? sellerAddr : liveOwner;
        METADATA_STORE.setItemOwner(dataId, liveOwner);
        (uint256 sellerProceeds, uint256 royaltyAmount) = _settleRoyaltyPayment(
            dataId,
            tokenId,
            address(this),
            seller,
            totalPrice
        );
        emit EscrowReleased(dataId, buyer, seller, sellerProceeds, royaltyAmount);
    }

    // =========================================================================
    // Dataset Lifecycle & Direct Access Administration
    // =========================================================================

    /**
     * @notice Change lifecycle status of a dataset (`Active`, `Paused`, `Revoked`).
     * @param dataId Dataset ID.
     * @param newStatus Target DataStatus value.
     */
    function updateDataStatus(uint256 dataId, DataStatus newStatus) external onlyMutableDataOwner(dataId) {
        DataStatus oldStatus = _core(dataId).status;
        if (oldStatus == newStatus) return;
        METADATA_STORE.setItemStatus(dataId, newStatus);
        ESCROW_ENGINE.onStatusTransition(dataId, uint8(oldStatus), uint8(newStatus));
        emit DataStatusUpdated(dataId, oldStatus, newStatus);
    }

    /**
     * @notice Update access license fee in `$GENO` wei for an active dataset.
     * @param dataId Dataset ID.
     * @param newPrice New license price in $GENO wei (must be > 0 and <= MAX_PRICE).
     */
    function updateDataPrice(uint256 dataId, uint256 newPrice) external onlyMutableDataOwner(dataId) {
        uint256 oldPrice = METADATA_STORE.setItemPrice(dataId, newPrice);
        emit DataPriceUpdated(dataId, oldPrice, newPrice);
    }

    /**
     * @notice Directly grant complimentary viewing access for a researcher/institution.
     * @param dataId Dataset ID.
     * @param recipient Researcher wallet receiving access.
     */
    function grantDirectAccess(uint256 dataId, address recipient) external onlyMutableDataOwner(dataId) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (recipient == msg.sender) revert SelfAccessNotAllowed();
        ItemMeta memory data = _requireActiveData(dataId);
        (uint256 expires, bool shouldCount) = ESCROW_ENGINE.recordComplimentaryGrant(
            dataId,
            recipient,
            data.accessDuration
        );
        if (shouldCount) METADATA_STORE.adjustAccessCount(dataId, true, address(0));
        emit DirectAccessGranted(dataId, recipient, expires);
    }

    // =========================================================================
    // PRE Key Capsule, Workers & Access Queries
    // =========================================================================

    /**
     * @notice Register persistent asymmetric public key (RSA-OAEP) for buyer-specific key wrapping.
     * @param publicKey Serialized JWK or SPKI representation of the researcher's public key.
     */
    function registerResearcherPublicKey(string calldata publicKey) external {
        METADATA_STORE.setResearcherPublicKey(msg.sender, publicKey);
        emit ResearcherKeyRegistered(msg.sender, publicKey);
    }

    /**
     * @notice Set or update the global authorized Capsule Dispatcher address.
     * @param newDispatcher New dispatcher address.
     */
    function setCapsuleDispatcher(address newDispatcher) external onlyOwner {
        if (newDispatcher == address(0)) revert InvalidRecipient();
        _setCapsuleDispatcher(newDispatcher);
    }

    /**
     * @notice Explicitly disable the global Capsule Dispatcher by clearing it to the zero address.
     * @dev Preserves `setCapsuleDispatcher(address(0))` input validation while enabling least-privilege
     *      sovereign deployment (`SKIP_SEEDING=1`) and timelock governance revocation.
     */
    function disableCapsuleDispatcher() external onlyOwner {
        _setCapsuleDispatcher(address(0));
    }

    function _setCapsuleDispatcher(address newDispatcher) internal {
        address oldDispatcher = capsuleDispatcher;
        capsuleDispatcher = newDispatcher;
        emit CapsuleDispatcherUpdated(oldDispatcher, newDispatcher);
    }

    /**
     * @notice Allow a dataset owner to opt out of (or re-enable) global capsuleDispatcher privileges.
     * @param dataId Target dataset ID.
     * @param disabled True to disable global capsuleDispatcher access for this dataset.
     */
    function setDispatcherOptOut(uint256 dataId, bool disabled) external onlyMutableDataOwner(dataId) {
        dispatcherDisabled[dataId] = disabled;
        emit DispatcherOptOutUpdated(dataId, disabled);
    }

    /**
     * @notice Return the linked GenomicZkVerifier contract address for zero-knowledge trait proofs.
     * @return Address of the linked GenomicZkVerifier contract.
     */
    function zkVerifier() external view returns (address) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Set or update the linked GenomicZkVerifier contract (interface-checked, zero active bounty orphaning).
     * @param newVerifier Address of the deployed GenomicZkVerifier contract.
     */
    function setZkVerifier(address newVerifier) external onlyOwner {
        address oldVerifier = METADATA_STORE.setZkVerifier(newVerifier);
        emit ZkVerifierUpdated(oldVerifier, newVerifier);
    }

    /**
     * @notice Epoch-scoped view preserving authorizedCapsuleWorkers(dataId, worker) ABI with O(1) revocation.
     * @return True if authorized under the active epoch and current NFT owner.
     */
    function authorizedCapsuleWorkers(uint256, address) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Epoch-scoped view preserving capsuleWorkerAuthorizer(dataId, worker) ABI with O(1) revocation.
     * @return Address that authorized `worker`, or `address(0)`.
     */
    function capsuleWorkerAuthorizer(uint256, address) external view returns (address) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Authorize or revoke a third-party capsule worker for a specific dataset in O(1).
     * @param dataId Dataset ID.
     * @param worker Worker address.
     * @param authorized True to authorize, false to revoke.
     */
    function setAuthorizedCapsuleWorker(
        uint256 dataId,
        address worker,
        bool authorized
    ) external onlyMutableDataOwner(dataId) {
        METADATA_STORE.setAuthorizedWorker(dataId, worker, authorized, msg.sender);
        emit CapsuleWorkerAuthorized(dataId, worker, authorized);
    }

    /**
     * @notice Check whether a worker is currently authorized under the active workerEpoch.
     * @return True if currently authorized.
     */
    function isAuthorizedWorker(uint256, address) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Reset authorized capsule workers when NFT ownership changes in O(1) (DEF2-1-05).
     * @param dataId Target dataset ID.
     */
    function resetAuthorizedWorkers(uint256 dataId) public {
        _requireValidDataId(dataId);
        address nftOwner = _ownerOf(_core(dataId).tokenId);
        if (msg.sender != address(GENOMIC_NFT) && msg.sender != nftOwner && msg.sender != owner()) {
            revert NotDataOwner();
        }
        METADATA_STORE.setItemOwner(dataId, nftOwner);
        METADATA_STORE.incrementWorkerEpoch(dataId);
    }

    /**
     * @notice Callback from GenomicNFT._update on transfer (DEF2-1-05).
     * @param tokenId NFT token ID being transferred.
     */
    function resetAuthorizedWorkersForToken(uint256 tokenId) external {
        if (msg.sender != address(GENOMIC_NFT)) revert NotDataOwner();
        uint256 dataId = tokenToDataId[tokenId];
        if (dataId != 0 && !(dataId > dataCount)) resetAuthorizedWorkers(dataId);
    }

    /**
     * @notice Store buyer-specific re-encrypted key capsule (Proxy Re-Encryption / RSA-OAEP).
     * @param dataId Target dataset ID.
     * @param researcher Target researcher address.
     * @param capsule Serialized RSA-OAEP JSON key capsule.
     */
    function storeTransformedCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) external nonReentrant onlyDataOwnerOrDispatcher(dataId) {
        _deliverCapsule(dataId, researcher, capsule, false);
    }

    /**
     * @notice Persist buyer-specific key capsule and broadcast CapsuleStored event.
     * @param dataId Target dataset ID.
     * @param researcher Target researcher address.
     * @param capsule Serialized RSA-OAEP JSON key capsule.
     */
    function emitTransformedCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) external nonReentrant onlyDataOwnerOrDispatcher(dataId) {
        _deliverCapsule(dataId, researcher, capsule, true);
        emit CapsuleStored(dataId, researcher, capsule);
    }

    function _deliverCapsule(uint256 dataId, address researcher, string calldata capsule, bool allowIdempotent) internal {
        if (researcher == address(0)) revert InvalidAddress();
        ItemMeta memory data = _requireActiveData(dataId);
        (bytes32 pkHash, bool hasKey) = METADATA_STORE.getResearcherPubKeyState(researcher);
        bytes32 newCapsuleHash = ESCROW_ENGINE.deliverCapsule(
            dataId,
            researcher,
            capsule,
            data.accessDuration,
            pkHash,
            hasKey,
            allowIdempotent
        );
        emit CapsuleDelivered(dataId, researcher, newCapsuleHash);
    }

    /**
     * @notice Retrieve the re-encrypted capsule (only authorized researcher with active grant and active dataset).
     * @param dataId Dataset identifier.
     * @return Serialized RSA-OAEP JSON key capsule.
     */
    function getTransformedCapsule(uint256 dataId) external view returns (string memory) {
        _requireValidDataId(dataId);
        _requireActiveData(dataId);
        _staticForwardRaw(
            address(ESCROW_ENGINE),
            abi.encodeCall(ESCROW_ENGINE.getBuyerCapsuleByMode, (dataId, msg.sender, 1))
        );
    }

    /**
     * @notice Data owner can view buyer's capsule when buyer grant is active.
     * @param dataId Dataset identifier.
     * @param researcher Target researcher address.
     * @return Serialized RSA-OAEP JSON key capsule or empty string if inactive.
     */
    function getCapsuleForBuyer(
        uint256 dataId,
        address researcher
    ) external view onlyDataOwner(dataId) returns (string memory) {
        _requireActiveData(dataId);
        _staticForwardRaw(
            address(ESCROW_ENGINE),
            abi.encodeCall(ESCROW_ENGINE.getBuyerCapsuleByMode, (dataId, researcher, 2))
        );
    }

    /**
     * @notice Public view for buyer's capsule enforcing caller authorization and lifecycle symmetry.
     * @param dataId Dataset identifier.
     * @param researcher Target researcher address.
     * @return Serialized RSA-OAEP JSON key capsule or empty string if caller unauthorized.
     */
    function buyerCapsules(uint256 dataId, address researcher) external view returns (string memory) {
        _requireValidDataId(dataId);
        ItemMeta memory data = _requireActiveData(dataId);
        uint8 mode = 0;
        if (msg.sender == researcher) {
            mode = 1;
        } else if (msg.sender == _safeOwnerOf(data.tokenId, data.currentOwner) || _isDispatcherOrWorker(dataId, msg.sender)) {
            mode = 2;
        }
        _staticForwardRaw(
            address(ESCROW_ENGINE),
            abi.encodeCall(ESCROW_ENGINE.getBuyerCapsuleByMode, (dataId, researcher, mode))
        );
    }

    /**
     * @notice Check whether an address has active permission to access a dataset.
     * @param dataId Dataset identifier.
     * @param researcher Candidate address.
     * @return active True if `researcher` is the active dataset NFT owner or holds a valid active grant.
     */
    function hasActiveAccess(uint256 dataId, address researcher) external view returns (bool active) {
        _requireValidDataId(dataId);
        if (researcher == address(0)) return false;
        ItemMeta memory data = _core(dataId);
        if (data.status != DataStatus.Active) return false;
        if (_safeOwnerOf(data.tokenId, address(0)) == researcher) return true;
        return ESCROW_ENGINE.hasValidBuyerGrant(dataId, researcher);
    }

    // =========================================================================
    // ZK Verifier Bridge & Catalog Queries (Delegated to GenomicsMetadataStore)
    // =========================================================================

    /**
     * @notice Check whether a registered dataset's owner has proven possession of a specific genomic trait via ZK-SNARKs.
     * @return True if the data owner has proven possession of the specific trait.
     */
    function verifyDatasetTraitPossession(uint256, bytes32, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Check whether a registered dataset's owner has proven possession of a genomic trait via ZK-SNARKs.
     * @return True if the data owner has proven possession without revealing the raw genome.
     */
    function verifyDatasetTraitPossession(uint256, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Check whether a registered dataset's original creator/owner has proven a genomic trait
     *         cryptographically bound to this exact dataset's encrypted rawDataHash via lab-attested ZK-SNARKs.
     * @return True if the donor has a current-epoch dataset-bound ZK verification for rawDataHash.
     */
    function verifyDatasetBoundTrait(uint256, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Check whether a donor has claimed a specific ZK genotype bounty verified by the linked Verifier.
     * @return True if the donor successfully claimed the bounty.
     */
    function hasDonorClaimedZkBounty(uint256, address) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice ABI-compatible public getter preserving `genomicDataItems(uint256)` tuple without duplicating CID storage.
     * @param id Dataset identifier.
     * @return dataId Dataset identifier (0 if unregistered).
     * @return tokenId Associated GenomicNFT token ID.
     * @return currentOwner Stored owner address.
     * @return rawDataHash SHA-256 hash of encrypted raw package.
     * @return rawCiphertextCid IPFS CID of encrypted raw file.
     * @return summaryCiphertextCid IPFS CID of encrypted clinical summary PDF.
     * @return metadataCid IPFS CID of GA4GH Phenopacket JSON.
     * @return price License price in $GENO wei.
     * @return accessDuration License duration in seconds.
     * @return status Current DataStatus enum value.
     * @return accessCount Cumulative access count.
     * @return registeredAt Registration block timestamp.
     */
    function genomicDataItems(uint256 id)
        external
        view
        returns (
            uint256 dataId,
            uint256 tokenId,
            address currentOwner,
            bytes32 rawDataHash,
            string memory rawCiphertextCid,
            string memory summaryCiphertextCid,
            string memory metadataCid,
            uint256 price,
            uint256 accessDuration,
            DataStatus status,
            uint256 accessCount,
            uint256 registeredAt
        )
    {
        return METADATA_STORE.genomicDataItems(id);
    }

    /**
     * @notice Get full details of a dataset with live NFT ownership synced.
     * @return GenomicData struct with current NFT owner.
     */
    function getGenomicData(uint256) external view returns (GenomicData memory) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Retrieve all registered genomic datasets (for marketplace catalog).
     * @return Array of all GenomicData structs with live NFT owners.
     */
    function getAllDataItems() external view returns (GenomicData[] memory) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Retrieve registered genomic datasets with pagination.
     * @param offset Starting zero-based dataset index.
     * @param limit Maximum number of datasets to return.
     * @return items Paginated array of GenomicData structs.
     * @return total Total registered dataset count.
     */
    function getDataItemsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (GenomicData[] memory items, uint256 total)
    {
        return METADATA_STORE.getDataItemsPaginated(offset, limit);
    }

    // =========================================================================
    // Rescue, Artifact Hashes, Blind Tags & Follow-on Study Reuse
    // =========================================================================

    /**
     * @notice Rescue mistakenly sent ERC-20 tokens to the registry contract (cannot rescue paymentToken).
     * @param tokenAddress The ERC-20 token address to rescue.
     * @param to The recipient address.
     * @param amount The token amount in wei.
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner nonReentrant {
        if (tokenAddress == address(0)) revert InvalidAddress();
        if (tokenAddress == address(PAYMENT_TOKEN)) revert CannotRescuePaymentToken();
        if (to == address(0)) revert InvalidRecipient();
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokensRescued(tokenAddress, to, amount);
    }

    /**
     * @notice Anchor summary report & GA4GH Phenopacket metadata SHA-256 hashes for an existing dataset.
     * @param dataId Dataset identifier.
     * @param summaryHash Non-zero SHA-256 hash of encrypted clinical summary PDF.
     * @param metadataHash Non-zero SHA-256 hash of public GA4GH Phenopacket JSON.
     */
    function anchorArtifactHashes(
        uint256 dataId,
        bytes32 summaryHash,
        bytes32 metadataHash
    ) external onlyMutableDataOwner(dataId) {
        METADATA_STORE.anchorArtifactHashes(dataId, summaryHash, metadataHash, true);
        emit ArtifactHashesAnchored(dataId, summaryHash, metadataHash);
    }

    /**
     * @notice Retrieve all 3 anchored cryptographic SHA-256 hashes (raw, summary, metadata).
     * @param dataId Dataset identifier.
     * @return rawDataHash Anchored encrypted raw package SHA-256 hash.
     * @return summaryDataHash Anchored encrypted summary PDF SHA-256 hash.
     * @return metadataHash Anchored public Phenopacket JSON SHA-256 hash.
     */
    function getArtifactHashes(uint256 dataId)
        external
        view
        returns (bytes32 rawDataHash, bytes32 summaryDataHash, bytes32 metadataHash)
    {
        return METADATA_STORE.getArtifactHashes(dataId);
    }

    /**
     * @notice Compute domain-separated salted keccak-256 blind trait tag off-chain or on-chain.
     * @param traitKey Trait key label (e.g. "gene", "trait").
     * @param traitValue Trait value label (e.g. "ALDH2", "rs671").
     * @param datasetSalt Dataset-specific 32-byte salt.
     * @return blindTag Domain-separated keccak-256 tag hash.
     */
    function computeBlindTag(
        string calldata traitKey,
        string calldata traitValue,
        bytes32 datasetSalt
    ) external pure returns (bytes32 blindTag) {
        return keccak256(abi.encode("GENOCHAIN_BLIND_TAG_V1", traitKey, traitValue, datasetSalt));
    }

    /**
     * @notice Replace or clear blinded trait search tags for a dataset (max 16 tags).
     * @param dataId Dataset identifier.
     * @param blindTags Unique non-zero blinded trait tags.
     */
    function setDatasetBlindTags(
        uint256 dataId,
        bytes32[] calldata blindTags
    ) external onlyMutableDataOwner(dataId) {
        _setBlindTagsInternal(dataId, blindTags);
    }

    /**
     * @notice ABI-compatible blind tag getter enforcing dataId bounds and Active lifecycle symmetry.
     * @return True if dataset is Active and contains `tagHash`.
     */
    function datasetBlindTags(uint256, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Serverless on-chain blind tag query enforcing Active lifecycle symmetry.
     * @return True if dataset is Active and contains `blindTag`.
     */
    function matchesBlindTag(uint256, bytes32) external view returns (bool) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Quote 5% follow-on study reuse fee (minimum 1 wei).
     * @return Follow-on study reuse fee in $GENO wei.
     */
    function quoteReuseFee(uint256) external view returns (uint256) {
        _staticForward(address(METADATA_STORE));
    }

    /**
     * @notice Record a follow-on study reuse payment (5% fee with EIP-2981 secondary creator split).
     * @dev `studyReuseReceipts[dataId][studyCommitment]` is intentionally unique across all buyers per `dataId`
     *      to prevent duplicate publication/study-ID replay. Off-chain callers should bind the researcher address
     *      into their `studyCommitment` preimage (e.g., `keccak256(abi.encode(researcher, studyId))`).
     * @param dataId Dataset identifier.
     * @param studyCommitment Non-zero unique commitment hash for the follow-on study.
     */
    function recordStudyReuse(uint256 dataId, bytes32 studyCommitment) external nonReentrant {
        _recordStudyReuse(dataId, studyCommitment, type(uint256).max);
    }

    /**
     * @notice Record a follow-on study reuse payment with MEV slippage protection against seller price spikes.
     * @param dataId Dataset identifier.
     * @param studyCommitment Non-zero unique commitment hash for the follow-on study.
     * @param maxFee Maximum acceptable reuse fee in $GENO wei.
     */
    function recordStudyReuse(uint256 dataId, bytes32 studyCommitment, uint256 maxFee) external nonReentrant {
        _recordStudyReuse(dataId, studyCommitment, maxFee);
    }

    function _recordStudyReuse(uint256 dataId, bytes32 studyCommitment, uint256 maxFee) internal {
        _requireValidDataId(dataId);
        ItemMeta memory data = _requireActiveData(dataId);
        address seller = _safeOwnerOf(data.tokenId, data.currentOwner);
        if (msg.sender == seller) revert SelfAccessNotAllowed();
        ESCROW_ENGINE.requireBuyerActiveAccess(dataId, msg.sender);
        METADATA_STORE.recordStudyReuseReceipt(dataId, studyCommitment);

        uint256 reuseFee = (data.price * REUSE_FEE_BPS) / 10_000;
        if (reuseFee < 1) reuseFee = 1;
        if (reuseFee > maxFee) revert PriceExceedsMax(reuseFee, maxFee);
        METADATA_STORE.setItemOwner(dataId, seller);

        (, uint256 royaltyAmount) = _settleRoyaltyPayment(dataId, data.tokenId, msg.sender, seller, reuseFee);
        emit StudyReuseRecorded(dataId, msg.sender, studyCommitment, reuseFee, royaltyAmount);
    }

    function _transferToken(address from, address to, uint256 amount) internal {
        if (amount < 1) return;
        if (from == address(this)) PAYMENT_TOKEN.safeTransfer(to, amount);
        else PAYMENT_TOKEN.safeTransferFrom(from, to, amount);
    }

    function _settleRoyaltyPayment(
        uint256 dataId,
        uint256 tokenId,
        address from,
        address seller,
        uint256 totalPrice
    ) internal returns (uint256 sellerProceeds, uint256 royaltyAmount) {
        (address royaltyReceiver, uint256 rawRoyalty) = GENOMIC_NFT.royaltyInfo(tokenId, totalPrice);
        if (royaltyReceiver != address(0) && totalPrice > 0) {
            if (rawRoyalty == 0 && royaltyReceiver != seller) {
                (address checkReceiver, uint256 bpsCheck) = GENOMIC_NFT.royaltyInfo(tokenId, 10_000);
                if (checkReceiver != address(0) && bpsCheck > 0) rawRoyalty = 1;
            }
            royaltyAmount = rawRoyalty > totalPrice ? totalPrice : rawRoyalty;
        }
        sellerProceeds = totalPrice - royaltyAmount;
        if (royaltyReceiver == seller || royaltyAmount == 0) {
            _transferToken(from, seller, totalPrice);
        } else {
            _transferToken(from, royaltyReceiver, royaltyAmount);
            _transferToken(from, seller, sellerProceeds);
        }
        if (royaltyAmount > 0) emit RoyaltyPaid(dataId, royaltyReceiver, royaltyAmount);
    }

    function _setBlindTagsInternal(uint256 dataId, bytes32[] calldata blindTags) internal {
        METADATA_STORE.setBlindTags(dataId, blindTags);
        uint256 len = blindTags.length;
        for (uint256 i = 0; i < len; ) {
            emit BlindTagRegistered(dataId, blindTags[i]);
            unchecked {
                ++i;
            }
        }
    }
}