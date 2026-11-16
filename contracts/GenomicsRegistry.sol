// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { GenomicNFT, IGenomicsRegistryWorkerSync } from "./GenomicNFT.sol";

interface IGenomicZkVerifier {
    function hasVerifiedVariant(bytes32 variantCommitment, address donor) external view returns (bool);
    function hasVerifiedTraitVariant(bytes32 targetTraitId, bytes32 variantCommitment, address donor) external view returns (bool);
    function hasClaimedBounty(uint256 bountyId, address donor) external view returns (bool);
}

/**
 * @title GenomicsRegistry
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Core registry contract for managing genomic data registration, access granting with escrow,
 *         status updates, and active on-chain disbursement of EIP-2981 royalties via royaltyInfo() queries.
 * @dev Comprehensive DeSci Genomic Registry implementing smart contracts, escrow, royalty settlement, and access control.
 */
contract GenomicsRegistry is Ownable, IGenomicsRegistryWorkerSync {
    using SafeERC20 for IERC20;

    error ReentrancyGuardReentrantCall();
    uint256 private _reentrancyStatus = 1;

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() internal {
        if (_reentrancyStatus == 2) revert ReentrancyGuardReentrantCall();
        _reentrancyStatus = 2;
    }

    function _nonReentrantAfter() internal {
        _reentrancyStatus = 1;
    }

    enum DataStatus { Active, Paused, Revoked }

    struct GenomicData {
        uint256 dataId;
        uint256 tokenId;
        address currentOwner;
        bytes32 rawDataHash;         // SHA-256 integrity hash of raw dataset
        string rawCiphertextCid;     // IPFS CID of encrypted raw sequence (.vcf/.fastq)
        string summaryCiphertextCid; // IPFS CID of encrypted summary report (.pdf)
        string metadataCid;          // IPFS CID of public GA4GH phenotype metadata (.json)
        uint256 price;               // Price in $GENO token wei
        uint256 accessDuration;      // Duration of access grant in seconds (e.g. 30 days)
        DataStatus status;
        uint256 accessCount;
        uint256 registeredAt;
    }

    struct AccessGrant {
        bool isGranted;
        uint256 grantedAt;
        uint256 expiresAt;
    }

    struct EscrowDeposit {
        address buyer;
        address seller;
        uint256 amount;
        uint256 depositTime;
        uint256 disputeWindow;
        bool released;
        bool refunded;
        bool capsuleDelivered;
    }

    IERC20 public immutable paymentToken;     // $GENO token
    GenomicNFT public immutable genomicNFT;   // ERC-721 + EIP-2981 Data Ownership NFT

    uint256 public dataCount;

    // dataId => GenomicData
    mapping(uint256 => GenomicData) public genomicDataItems;

    // dataId => researcher => AccessGrant
    mapping(uint256 => mapping(address => AccessGrant)) public accessGrants;

    // dataId => researcher => buyer-specific re-encrypted key capsule (Proxy Re-encryption / Asymmetric RSA-OAEP)
    mapping(uint256 => mapping(address => string)) internal _buyerCapsules;

    // dataId => buyer => EscrowDeposit (Timelocked escrow with dispute guarantee)
    mapping(uint256 => mapping(address => EscrowDeposit)) public escrowDeposits;

    // researcher address => public key string (RSA-OAEP JWK or SPKI for buyer-specific key wrapping)
    mapping(address => string) public researcherPublicKeys;

    // rawDataHash => registered status (Anti-fraud: prevents duplicate clone registrations)
    mapping(bytes32 => bool) public registeredRawDataHashes;

    // Authorized Re-encryption Proxy / Capsule Dispatcher (daemon or trusted key coordinator)
    address public capsuleDispatcher;

    /// @notice Linked Zero-Knowledge Trait Bounty Verifier (zk-Genomics Module)
    address public zkVerifier;

    // dataId => worker address => authorization status
    mapping(uint256 => mapping(address => bool)) public authorizedCapsuleWorkers;

    // dataId => worker address => authorizer owner address (DEF2-1-05)
    mapping(uint256 => mapping(address => address)) public capsuleWorkerAuthorizer;
    mapping(uint256 => address[]) internal _authorizedWorkersList;

    // dataId => worker revocation epoch counter for O(1) invalidation
    mapping(uint256 => uint256) public workerEpoch;
    mapping(uint256 => mapping(address => uint256)) public workerAuthorizedEpoch;

    // dataId => buyer => dispute status & manual confirmation preferences
    mapping(uint256 => mapping(address => bool)) public escrowDisputed;
    mapping(uint256 => mapping(address => bool)) public manualEscrowRelease;

    // dataId => worker address => 1-based index in _authorizedWorkersList (O(1) prune)
    mapping(uint256 => mapping(address => uint256)) internal _workerIndex;


    // tokenId => dataId
    mapping(uint256 => uint256) public tokenToDataId;

    uint256 public constant MAX_BLIND_TAGS_PER_DATASET = 16;
    uint256 public constant REUSE_FEE_BPS = 500;

    // 3-Artifact integrity hashes (raw ciphertext already stored in GenomicData.rawDataHash)
    mapping(uint256 => bytes32) public summaryDataHashes;
    mapping(uint256 => bytes32) public metadataHashes;

    // Serverless Privacy-Preserving Blinded Keccak-256 Trait Tag Search
    mapping(uint256 => mapping(bytes32 => bool)) public datasetBlindTags;
    mapping(uint256 => uint256) public datasetBlindTagCount;
    mapping(uint256 => bytes32[]) internal _datasetBlindTagList;

    // On-chain study reuse fee receipts (5% reuse fee + secondary EIP-2981 royalty split)
    mapping(uint256 => mapping(bytes32 => bool)) public studyReuseReceipts;
    mapping(uint256 => uint256) public datasetReuseCount;

    // Anti-front-running commit-reveal registration commitments: commitment => commit block number
    mapping(bytes32 => uint256) public registrationCommitments;
    bool public commitRevealRequired;

    // Custom Errors (Gas optimization)
    error NotDataOwner();
    error DataNotActive();
    error InvalidPrice();
    error InvalidDuration();
    error AccessAlreadyActive();
    error EscrowAlreadyActive();
    error OwnerCannotBuyOwnData();
    error DataNotFound();
    error InvalidDataHashOrCid();
    error DataAlreadyRegistered();
    error EmptyPublicKey();
    error InvalidRecipient();
    error EscrowNotActive();
    error DisputeWindowActive();
    error DisputeWindowExpired();
    error EscrowDisputedError();
    error EscrowNotDisputed();
    error CapsuleAlreadyDelivered();
    error CapsuleNotDelivered();
    error InvalidDisputeWindow();
    error EmptyCapsule();
    error InvalidAddress();
    error AccessExpired();
    error AccessNotGranted();
    error TokenIdMismatch();
    error ConsentPermanentlyRevoked();
    error SelfAccessNotAllowed();
    error PriceExceedsMax(uint256 currentPrice, uint256 maxPrice);
    error CannotRescuePaymentToken();
    error InvalidCapsuleFormat();
    error ArtifactHashesAlreadyAnchored();
    error InvalidBlindTag();
    error InvalidStudyCommitment();
    error StudyReuseAlreadyRecorded();
    error InvalidCommitment();
    error CommitmentAlreadyExists();
    error CommitmentNotFound();
    error CommitmentTooNew();

    // Events
    event TokensRescued(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event ResearcherKeyRegistered(
        address indexed researcher,
        string publicKey
    );
    event CapsuleDispatcherUpdated(
        address indexed oldDispatcher,
        address indexed newDispatcher
    );
    event ZkVerifierUpdated(
        address indexed oldVerifier,
        address indexed newVerifier
    );
    event CapsuleWorkerAuthorized(
        uint256 indexed dataId,
        address indexed worker,
        bool authorized
    );
    event GenomicDataRegistered(
        uint256 indexed dataId,
        uint256 indexed tokenId,
        address indexed owner,
        bytes32 rawDataHash,
        uint256 price,
        string metadataCid
    );

    event AccessGranted(
        uint256 indexed dataId,
        address indexed researcher,
        uint256 paidAmount,
        uint256 royaltyAmount,
        uint256 expiresAt
    );

    event DataPriceUpdated(
        uint256 indexed dataId,
        uint256 oldPrice,
        uint256 newPrice
    );

    event DirectAccessGranted(
        uint256 indexed dataId,
        address indexed recipient,
        uint256 expiresAt
    );

    event DataStatusUpdated(
        uint256 indexed dataId,
        DataStatus oldStatus,
        DataStatus newStatus
    );

    event CapsuleStored(
        uint256 indexed dataId,
        address indexed researcher,
        string capsule
    );

    event RoyaltyPaid(
        uint256 indexed dataId,
        address indexed creator,
        uint256 amount
    );

    event EscrowDeposited(
        uint256 indexed dataId,
        address indexed buyer,
        uint256 amount,
        uint256 disputeWindow
    );

    event EscrowReleased(
        uint256 indexed dataId,
        address indexed buyer,
        address indexed seller,
        uint256 sellerProceeds,
        uint256 royaltyAmount
    );

    event EscrowRefunded(
        uint256 indexed dataId,
        address indexed buyer,
        uint256 amount
    );

    event EscrowDisputed(
        uint256 indexed dataId,
        address indexed buyer
    );

    event EscrowDisputeResolved(
        uint256 indexed dataId,
        address indexed buyer,
        bool indexed refundBuyer,
        uint256 amount
    );

    event EscrowConfirmed(
        uint256 indexed dataId,
        address indexed buyer
    );

    event GenomicDataCommitted(
        bytes32 indexed commitment,
        address indexed donor,
        uint256 blockNumber
    );

    event CommitRevealRequirementUpdated(bool required);


    event ArtifactHashesAnchored(
        uint256 indexed dataId,
        bytes32 summaryHash,
        bytes32 metadataHash
    );

    event BlindTagRegistered(
        uint256 indexed dataId,
        bytes32 indexed blindTag
    );

    event StudyReuseRecorded(
        uint256 indexed dataId,
        address indexed researcher,
        bytes32 indexed studyCommitment,
        uint256 totalFee,
        uint256 royaltyPaid
    );

    modifier onlyDataOwner(uint256 dataId) {
        _checkDataOwner(dataId);
        _;
    }

    modifier onlyDataOwnerOrDispatcher(uint256 dataId) {
        _checkDataOwnerOrDispatcher(dataId);
        _;
    }

    function _requireValidDataId(uint256 dataId) internal view {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
    }

    function _checkDataOwner(uint256 dataId) internal view {
        _requireValidDataId(dataId);
        if (msg.sender != genomicNFT.ownerOf(genomicDataItems[dataId].tokenId)) {
            revert NotDataOwner();
        }
    }

    function _checkDataOwnerOrDispatcher(uint256 dataId) internal view {
        _requireValidDataId(dataId);
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        bool isWorker = isAuthorizedWorker(dataId, msg.sender);
        if (
            msg.sender != nftOwner &&
            msg.sender != capsuleDispatcher &&
            !isWorker
        ) {
            revert NotDataOwner();
        }
    }

    function _safeOwnerOf(uint256 tokenId, address fallbackOwner) internal view returns (address) {
        (bool ok, bytes memory data) = address(genomicNFT).staticcall(
            abi.encodeWithSelector(0x6352211e, tokenId)
        );
        if (ok && data.length == 32) {
            return abi.decode(data, (address));
        }
        return fallbackOwner;
    }

    constructor(
        address _paymentToken,
        address _genomicNFT,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_paymentToken == address(0) || _genomicNFT == address(0) || initialOwner == address(0)) {
            revert InvalidRecipient();
        }
        paymentToken = IERC20(_paymentToken);
        genomicNFT = GenomicNFT(_genomicNFT);
        capsuleDispatcher = initialOwner;
    }

    // =========================================================================
    // Core Business Functions
    // =========================================================================

    /**
     * @notice Toggle strict commit-reveal registration mode to block mempool front-running
     * @param required True to require prior commitGenomicData() before register calls
     */
    function setCommitRevealRequired(bool required) external onlyOwner {
        commitRevealRequired = required;
        emit CommitRevealRequirementUpdated(required);
    }

    /**
     * @notice Submit salted commitment keccak256(abi.encodePacked(rawDataHash, salt, msg.sender))
     *         prior to revealing genomic dataset parameters
     * @param commitment Salted hash commitment binding rawDataHash, salt, and msg.sender
     */
    function commitGenomicData(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        bytes32 commitKey = keccak256(abi.encodePacked(commitment, msg.sender));
        if (registrationCommitments[commitKey] != 0) revert CommitmentAlreadyExists();
        registrationCommitments[commitKey] = block.number;
        emit GenomicDataCommitted(commitment, msg.sender, block.number);
    }

    /**
     * @notice Reveal salted commitment in a later block and register encrypted genomic dataset
     * @param rawDataHash SHA-256 hash of encrypted raw ciphertext package
     * @param salt Secret 32-byte salt used when computing commitment
     * @param cidsAndUri [rawCid, summaryCid, metadataCid, tokenUri]
     * @param price Access fee in $GENO wei
     * @param accessDuration Access period in seconds
     * @param royaltyBps Creator royalty in basis points
     * @return dataId Registered dataset ID
     */
    function revealAndRegisterGenomicData(
        bytes32 rawDataHash,
        bytes32 salt,
        string[4] calldata cidsAndUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) external nonReentrant returns (uint256 dataId) {
        bytes32 commitment = keccak256(abi.encodePacked(rawDataHash, salt, msg.sender));
        bytes32 commitKey = keccak256(abi.encodePacked(commitment, msg.sender));
        uint256 commitBlock = registrationCommitments[commitKey];
        if (commitBlock == 0) revert CommitmentNotFound();
        if (block.number <= commitBlock) revert CommitmentTooNew();
        delete registrationCommitments[commitKey];

        dataId = _validateAndInitData(
            rawDataHash,
            cidsAndUri[0],
            cidsAndUri[1],
            cidsAndUri[2],
            bytes(cidsAndUri[3]).length,
            price,
            accessDuration
        );
        _mintStoredNft(dataId, cidsAndUri[3], royaltyBps);
    }

    /**
     * @notice 1. registerGenomicData(): Register encrypted genomic dataset on-chain.
     *         Mints a Genomic NFT with EIP-2981 royalty directly to the contributor.
     * @dev CHECKS-EFFECTS-INTERACTIONS: All internal state variables are updated
     *      BEFORE the external minting call to eliminate reentrancy vectors.
     * @param rawDataHash SHA-256 hash of the complete encrypted raw ciphertext package
     * @param rawCid IPFS CID of encrypted raw sequence
     * @param summaryCid IPFS CID of encrypted summary report
     * @param metadataCid IPFS CID of public GA4GH phenotype metadata JSON
     * @param tokenUri IPFS URI for ERC-721 token metadata
     * @param price Access fee in $GENO tokens
     * @param accessDuration Access period in seconds
     * @param royaltyBps Basis points for creator royalty
     * @return dataId Registered data ID
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
        if (commitRevealRequired) revert CommitmentNotFound();
        dataId = _validateAndInitData(
            rawDataHash,
            rawCid,
            summaryCid,
            metadataCid,
            bytes(tokenUri).length,
            price,
            accessDuration
        );
        _mintStoredNft(dataId, tokenUri, royaltyBps);
    }

    function registerGenomicDataBundle(
        bytes32[3] calldata hashes,
        string[4] calldata cidsAndUri,
        uint256 priceInGeno,
        uint256 accessDurationSeconds,
        uint96 royaltyBps,
        bytes32[] calldata blindTags
    ) external nonReentrant returns (uint256 newDataId) {
        if (commitRevealRequired) revert CommitmentNotFound();
        if (hashes[1] == bytes32(0) || hashes[2] == bytes32(0)) revert InvalidDataHashOrCid();
        newDataId = _validateAndInitData(
            hashes[0],
            cidsAndUri[0],
            cidsAndUri[1],
            cidsAndUri[2],
            bytes(cidsAndUri[3]).length,
            priceInGeno,
            accessDurationSeconds
        );
        summaryDataHashes[newDataId] = hashes[1];
        metadataHashes[newDataId] = hashes[2];
        if (blindTags.length > 0) {
            _setBlindTagsInternal(newDataId, blindTags);
        }
        emit ArtifactHashesAnchored(newDataId, hashes[1], hashes[2]);
        _mintStoredNft(newDataId, cidsAndUri[3], royaltyBps);
    }

    function _validateAndInitData(
        bytes32 rawDataHash,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        uint256 tokenUriLen,
        uint256 price,
        uint256 accessDuration
    ) internal returns (uint256 newDataId) {
        if (rawDataHash == bytes32(0) || tokenUriLen == 0) revert InvalidDataHashOrCid();
        for (uint256 k = 0; k < 3; ) {
            string calldata cid = k == 0 ? rawCid : (k == 1 ? summaryCid : metadataCid);
            if (!_isValidCid(cid)) revert InvalidDataHashOrCid();
            unchecked { ++k; }
        }
        if (registeredRawDataHashes[rawDataHash]) revert DataAlreadyRegistered();

        if (price == 0) revert InvalidPrice();
        if (accessDuration == 0) revert InvalidDuration();

        registeredRawDataHashes[rawDataHash] = true;
        uint256 expectedTokenId = genomicNFT.nextTokenId();
        newDataId = ++dataCount;

        tokenToDataId[expectedTokenId] = newDataId;
        GenomicData storage item = genomicDataItems[newDataId];
        item.dataId = newDataId;
        item.tokenId = expectedTokenId;
        item.currentOwner = msg.sender;
        item.rawDataHash = rawDataHash;
        item.rawCiphertextCid = rawCid;
        item.summaryCiphertextCid = summaryCid;
        item.metadataCid = metadataCid;
        item.price = price;
        item.accessDuration = accessDuration;
        item.status = DataStatus.Active;
        item.registeredAt = block.timestamp;
    }

    function _mintStoredNft(
        uint256 dataId,
        string calldata tokenUri,
        uint96 royaltyBps
    ) internal {
        GenomicData storage item = genomicDataItems[dataId];
        uint256 mintedTokenId = genomicNFT.mintGenomicNFT(
            msg.sender,
            tokenUri,
            item.rawDataHash,
            item.rawCiphertextCid,
            item.summaryCiphertextCid,
            item.metadataCid,
            royaltyBps
        );
        if (mintedTokenId != item.tokenId) revert TokenIdMismatch();
        emit GenomicDataRegistered(
            dataId,
            mintedTokenId,
            msg.sender,
            item.rawDataHash,
            item.price,
            item.metadataCid
        );
    }

    /**
     * @notice 2. grantAccess(): Researcher pays via Escrow and is granted time-locked access.
     *         Actively queries EIP-2981 royaltyInfo(), deducts 10% royalty from purchase price, and disburses to original data creator!
     *         Overload without maxPrice (defaults to maxPrice = type(uint256).max).
     * @param dataId Target dataset ID to purchase access for
     */
    function grantAccess(uint256 dataId) external nonReentrant {
        _grantAccessInternal(dataId, type(uint256).max);
    }

    /**
     * @notice grantAccess(): Researcher pays and is granted time-locked access with MEV slippage protection.
     *         Reverts with PriceExceedsMax if seller front-runs by raising data.price > maxPrice.
     * @param dataId Target dataset ID to purchase access for
     * @param maxPrice Maximum price in $GENO wei the buyer is willing to pay
     */
    function grantAccess(uint256 dataId, uint256 maxPrice) external nonReentrant {
        _grantAccessInternal(dataId, maxPrice);
    }

    function _validatePurchase(
        uint256 dataId,
        uint256 maxPrice
    ) internal view returns (GenomicData storage data, address seller) {
        _requireValidDataId(dataId);
        data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();
        if (data.price > maxPrice) revert PriceExceedsMax(data.price, maxPrice);

        seller = genomicNFT.ownerOf(data.tokenId);
        if (msg.sender == seller) revert OwnerCannotBuyOwnData();

        AccessGrant storage grant = accessGrants[dataId][msg.sender];
        if (grant.isGranted && block.timestamp < grant.expiresAt) {
            revert AccessAlreadyActive();
        }
    }

    function _clearSettledEscrow(uint256 dataId, address user) internal {
        EscrowDeposit storage existingDeposit = escrowDeposits[dataId][user];
        if (existingDeposit.amount > 0) {
            if (!existingDeposit.released && !existingDeposit.refunded) revert EscrowAlreadyActive();
            delete escrowDeposits[dataId][user];
        }
        escrowDisputed[dataId][user] = false;
    }

    function _grantAccessInternal(uint256 dataId, uint256 maxPrice) internal {
        (GenomicData storage data, address seller) = _validatePurchase(dataId, maxPrice);
        _clearSettledEscrow(dataId, msg.sender);

        uint256 totalPrice = data.price;

        // CHECKS-EFFECTS-INTERACTIONS: Update all state variables BEFORE making external calls
        uint256 expires = block.timestamp + data.accessDuration;
        ++data.accessCount;
        data.currentOwner = seller; // Sync latest NFT holder

        delete _buyerCapsules[dataId][msg.sender];
        accessGrants[dataId][msg.sender] = AccessGrant(true, block.timestamp, expires);

        (, uint256 royaltyAmount) = _settleRoyaltyPayment(
            dataId,
            data.tokenId,
            msg.sender,
            seller,
            totalPrice
        );

        emit AccessGranted(dataId, msg.sender, totalPrice, royaltyAmount, expires);
    }

    /**
     * @notice Purchase access with timelocked escrow protection & dispute refund guarantee.
     *         Payment is held safely in contract escrow until capsule is delivered.
     *         If capsule is not delivered within disputeWindow, buyer can claim 100% refund.
     * @param dataId Target dataset ID
     * @param disputeWindow Time window in seconds (e.g. 1 days) for seller/dispatcher to deliver capsule
     */
    function grantAccessWithEscrow(uint256 dataId, uint256 disputeWindow) external nonReentrant {
        _grantAccessWithEscrowInternal(dataId, disputeWindow, type(uint256).max);
    }

    /**
     * @notice Purchase access with timelocked escrow protection & MEV slippage protection.
     * @param dataId Target dataset ID
     * @param disputeWindow Time window in seconds (e.g. 1 days) for seller/dispatcher to deliver capsule
     * @param maxPrice Maximum price in $GENO wei the buyer is willing to pay
     */
    function grantAccessWithEscrow(uint256 dataId, uint256 disputeWindow, uint256 maxPrice) external nonReentrant {
        _grantAccessWithEscrowInternal(dataId, disputeWindow, maxPrice);
    }

    function _grantAccessWithEscrowInternal(uint256 dataId, uint256 disputeWindow, uint256 maxPrice) internal {
        (GenomicData storage data, address seller) = _validatePurchase(dataId, maxPrice);

        EscrowDeposit storage dep = escrowDeposits[dataId][msg.sender];
        if (dep.amount > 0 && !dep.released && !dep.refunded) {
            if (block.timestamp < dep.depositTime + data.accessDuration) {
                revert AccessAlreadyActive();
            }
            revert EscrowAlreadyActive();
        }

        if (disputeWindow < 1 hours || disputeWindow > 30 days) revert InvalidDisputeWindow();

        uint256 totalPrice = data.price;
        ++data.accessCount;
        data.currentOwner = seller;

        delete _buyerCapsules[dataId][msg.sender];
        delete accessGrants[dataId][msg.sender];

        escrowDeposits[dataId][msg.sender] = EscrowDeposit({
            buyer: msg.sender,
            seller: seller,
            amount: totalPrice,
            depositTime: block.timestamp,
            disputeWindow: disputeWindow,
            released: false,
            refunded: false,
            capsuleDelivered: false
        });
        escrowDisputed[dataId][msg.sender] = false;
        manualEscrowRelease[dataId][msg.sender] = false;

        paymentToken.safeTransferFrom(msg.sender, address(this), totalPrice);

        emit EscrowDeposited(dataId, msg.sender, totalPrice, disputeWindow);
    }

    function _requireActiveEscrow(uint256 dataId, address buyer) internal view returns (EscrowDeposit storage deposit) {
        _requireValidDataId(dataId);
        deposit = escrowDeposits[dataId][buyer];
        if (deposit.amount == 0 || deposit.released || deposit.refunded) revert EscrowNotActive();
    }

    /**
     * @notice Buyer toggles manual confirmation release for their escrow
     */
    function setManualEscrowRelease(uint256 dataId, bool manual) external {
        _requireActiveEscrow(dataId, msg.sender);
        manualEscrowRelease[dataId][msg.sender] = manual;
    }

    /**
     * @notice Dispute a delivered capsule during the active dispute window (freezes escrow for admin arbitration)
     * @param dataId Target dataset ID
     */
    function disputeCapsule(uint256 dataId) external {
        EscrowDeposit storage deposit = _requireActiveEscrow(dataId, msg.sender);
        if (!deposit.capsuleDelivered) revert CapsuleNotDelivered();
        if (escrowDisputed[dataId][msg.sender]) revert EscrowDisputedError();
        if (block.timestamp >= deposit.depositTime + deposit.disputeWindow) revert DisputeWindowExpired();
        escrowDisputed[dataId][msg.sender] = true;
        accessGrants[dataId][msg.sender].isGranted = false;
        emit EscrowDisputed(dataId, msg.sender);
    }

    /**
     * @notice Buyer explicitly confirms satisfactory capsule delivery and releases escrow immediately
     * @param dataId Target dataset ID
     */
    function confirmCapsuleAndReleaseEscrow(uint256 dataId) external nonReentrant {
        EscrowDeposit storage deposit = _requireActiveEscrow(dataId, msg.sender);
        if (!deposit.capsuleDelivered) revert CapsuleNotDelivered();
        emit EscrowConfirmed(dataId, msg.sender);
        _releaseEscrowInternal(dataId, msg.sender);
    }

    /**
     * @notice Claim a 100% refund when capsule is not delivered before dispute window expires (or dataset deactivated pre-delivery)
     * @param dataId Target dataset ID
     */
    function claimEscrowRefund(uint256 dataId) external nonReentrant {
        _requireValidDataId(dataId);
        EscrowDeposit storage deposit = escrowDeposits[dataId][msg.sender];
        if (deposit.amount == 0 || deposit.refunded) revert EscrowNotActive();
        if (deposit.released || deposit.capsuleDelivered) revert CapsuleAlreadyDelivered();

        bool canRefundImmediately = (genomicDataItems[dataId].status != DataStatus.Active);
        if (!canRefundImmediately && block.timestamp < deposit.depositTime + deposit.disputeWindow) {
            revert DisputeWindowActive();
        }

        _refundEscrowInternal(dataId, msg.sender);
    }

    /**
     * @notice Arbiter governance resolves a post-delivery escrow dispute (either 100% buyer refund or release to seller + royalty)
     * @param dataId Target dataset ID
     * @param buyer Disputing buyer address
     * @param refundBuyer True to refund 100% to buyer and purge capsule/grant; false to release funds to seller + EIP-2981 royalty
     */
    function resolveEscrowDispute(
        uint256 dataId,
        address buyer,
        bool refundBuyer
    ) external onlyOwner nonReentrant {
        if (buyer == address(0)) revert InvalidAddress();
        EscrowDeposit storage deposit = _requireActiveEscrow(dataId, buyer);
        if (!escrowDisputed[dataId][buyer]) revert EscrowNotDisputed();

        if (refundBuyer) {
            uint256 amt = _refundEscrowInternal(dataId, buyer);
            emit EscrowDisputeResolved(dataId, buyer, true, amt);
        } else {
            _releaseEscrowInternal(dataId, buyer);
            emit EscrowDisputeResolved(dataId, buyer, false, deposit.amount);
        }
    }

    function _refundEscrowInternal(uint256 dataId, address buyer) internal returns (uint256 refundAmount) {
        EscrowDeposit storage deposit = escrowDeposits[dataId][buyer];
        refundAmount = deposit.amount;
        deposit.refunded = true;
        escrowDisputed[dataId][buyer] = false;
        delete _buyerCapsules[dataId][buyer];
        delete accessGrants[dataId][buyer];
        if (genomicDataItems[dataId].accessCount > 0) {
            --genomicDataItems[dataId].accessCount;
        }
        paymentToken.safeTransfer(buyer, refundAmount);
        emit EscrowRefunded(dataId, buyer, refundAmount);
    }

    /**
     * @notice Manually release escrowed payment to seller once capsule is verified/delivered and dispute window passes
     * @param dataId Target dataset ID
     * @param buyer Target buyer address
     */
    function releaseEscrow(uint256 dataId, address buyer) external nonReentrant {
        EscrowDeposit storage deposit = _requireActiveEscrow(dataId, buyer);
        if (!deposit.capsuleDelivered) revert CapsuleNotDelivered();
        if (escrowDisputed[dataId][buyer]) revert EscrowDisputedError();

        if (msg.sender != buyer) {
            if (block.timestamp < deposit.depositTime + deposit.disputeWindow) {
                revert DisputeWindowActive();
            }
            address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
            if (msg.sender != deposit.seller && msg.sender != nftOwner) {
                revert NotDataOwner();
            }
        }

        _releaseEscrowInternal(dataId, buyer);
    }

    /**
     * @dev Internal helper to query EIP-2981 royaltyInfo(), disburse payment to seller, and route royalty to original creator upon capsule delivery
     */
    function _releaseEscrowInternal(uint256 dataId, address buyer) internal {
        EscrowDeposit storage deposit = escrowDeposits[dataId][buyer];
        if (deposit.amount == 0 || deposit.released || deposit.refunded) {
            return;
        }

        escrowDisputed[dataId][buyer] = false;

        GenomicData storage data = genomicDataItems[dataId];
        address seller = deposit.seller != address(0) ? deposit.seller : genomicNFT.ownerOf(data.tokenId);
        data.currentOwner = _safeOwnerOf(data.tokenId, seller);
        uint256 totalPrice = deposit.amount;
        deposit.released = true;

        accessGrants[dataId][buyer] = AccessGrant(true, block.timestamp, block.timestamp + data.accessDuration);

        (uint256 sellerProceeds, uint256 royaltyAmount) = _settleRoyaltyPayment(
            dataId,
            data.tokenId,
            address(this),
            seller,
            totalPrice
        );

        emit EscrowReleased(dataId, buyer, seller, sellerProceeds, royaltyAmount);
    }

    /**
     * @notice 3. updateDataStatus(): Change status of the dataset (Active, Paused, Revoked).
     *         Enforces Access Control Rule: Only data owner can execute!
     * @param dataId Dataset ID
     * @param newStatus New status to set
     */
    function updateDataStatus(uint256 dataId, DataStatus newStatus) external onlyDataOwner(dataId) {
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status == DataStatus.Revoked) revert ConsentPermanentlyRevoked();
        DataStatus oldStatus = data.status;
        data.status = newStatus;

        emit DataStatusUpdated(dataId, oldStatus, newStatus);
    }

    /**
     * @notice updateDataPrice(): Change access fee in $GENO tokens for the dataset.
     *         Enforces Access Control Rule: Only data owner can execute!
     * @param dataId Dataset ID
     * @param newPrice New price in $GENO wei
     */
    function updateDataPrice(uint256 dataId, uint256 newPrice) external onlyDataOwner(dataId) {
        if (newPrice == 0) revert InvalidPrice();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status == DataStatus.Revoked) revert ConsentPermanentlyRevoked();
        if (data.status != DataStatus.Active) revert DataNotActive();
        uint256 oldPrice = data.price;
        data.price = newPrice;
        emit DataPriceUpdated(dataId, oldPrice, newPrice);
    }

    /**
     * @notice grantDirectAccess(): Data Owner directly grants viewing access for a researcher/institution.
     *         Enforces Access Control Rule: Only data owner can execute!
     * @param dataId Dataset ID
     * @param recipient Researcher receiving access
     */
    function grantDirectAccess(uint256 dataId, address recipient) external onlyDataOwner(dataId) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (recipient == msg.sender) revert SelfAccessNotAllowed();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();

        _clearSettledEscrow(dataId, recipient);

        AccessGrant storage currentGrant = accessGrants[dataId][recipient];
        if (!currentGrant.isGranted || block.timestamp >= currentGrant.expiresAt) {
            ++data.accessCount;
        }

        uint256 expires = block.timestamp + data.accessDuration;

        currentGrant.isGranted = true;
        currentGrant.grantedAt = block.timestamp;
        currentGrant.expiresAt = expires;

        emit DirectAccessGranted(dataId, recipient, expires);
    }

    // =========================================================================
    // PRE Key Capsule & Access Query Helpers
    // =========================================================================

    /**
     * @notice Register persistent asymmetric public key (RSA-OAEP) for recipient key wrapping
     * @param publicKey Serialized JWK or SPKI representation of the researcher's public key
     */
    function registerResearcherPublicKey(string calldata publicKey) external {
        if (bytes(publicKey).length == 0) revert EmptyPublicKey();
        researcherPublicKeys[msg.sender] = publicKey;
        emit ResearcherKeyRegistered(msg.sender, publicKey);
    }

    /**
     * @notice Set or update the authorized Capsule Dispatcher
     * @param newDispatcher New dispatcher address
     */
    function setCapsuleDispatcher(address newDispatcher) external onlyOwner {
        if (newDispatcher == address(0)) revert InvalidRecipient();
        address oldDispatcher = capsuleDispatcher;
        capsuleDispatcher = newDispatcher;
        emit CapsuleDispatcherUpdated(oldDispatcher, newDispatcher);
    }

    /**
     * @notice Set or update the linked GenomicZkVerifier contract
     * @param newVerifier Address of the deployed GenomicZkVerifier contract
     */
    function setZkVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert InvalidRecipient();
        address oldVerifier = zkVerifier;
        zkVerifier = newVerifier;
        emit ZkVerifierUpdated(oldVerifier, newVerifier);
    }

    /**
     * @notice Authorize or revoke a third-party capsule worker for a specific dataset
     * @param dataId Dataset ID
     * @param worker Worker address
     * @param authorized True to authorize, false to revoke
     */
    function setAuthorizedCapsuleWorker(
        uint256 dataId,
        address worker,
        bool authorized
    ) external onlyDataOwner(dataId) {
        if (worker == address(0)) revert InvalidRecipient();
        if (authorized) {
            if (!authorizedCapsuleWorkers[dataId][worker] || workerAuthorizedEpoch[dataId][worker] != workerEpoch[dataId]) {
                _authorizedWorkersList[dataId].push(worker);
                _workerIndex[dataId][worker] = _authorizedWorkersList[dataId].length;
            }
            capsuleWorkerAuthorizer[dataId][worker] = msg.sender;
            workerAuthorizedEpoch[dataId][worker] = workerEpoch[dataId];
            authorizedCapsuleWorkers[dataId][worker] = true;
        } else {
            authorizedCapsuleWorkers[dataId][worker] = false;
            capsuleWorkerAuthorizer[dataId][worker] = address(0);
            workerAuthorizedEpoch[dataId][worker] = 0;
            uint256 idx1 = _workerIndex[dataId][worker];
            if (idx1 > 0) {
                address[] storage list = _authorizedWorkersList[dataId];
                uint256 len = list.length;
                if (idx1 <= len) {
                    address lastWorker = list[len - 1];
                    list[idx1 - 1] = lastWorker;
                    _workerIndex[dataId][lastWorker] = idx1;
                    list.pop();
                }
                delete _workerIndex[dataId][worker];
            }
        }
        emit CapsuleWorkerAuthorized(dataId, worker, authorized);
    }

    /**
     * @notice Check whether a worker is currently authorized under the active workerEpoch
     */
    function isAuthorizedWorker(uint256 dataId, address worker) public view returns (bool) {
        if (!authorizedCapsuleWorkers[dataId][worker]) return false;
        if (workerAuthorizedEpoch[dataId][worker] != workerEpoch[dataId]) return false;
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        return capsuleWorkerAuthorizer[dataId][worker] == nftOwner;
    }

    /**
     * @notice Reset authorized capsule workers when NFT ownership changes (DEF2-1-05)
     * @param dataId Target dataset ID
     */
    function resetAuthorizedWorkers(uint256 dataId) public {
        _requireValidDataId(dataId);
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        if (msg.sender != address(genomicNFT) && msg.sender != nftOwner && msg.sender != owner()) {
            revert NotDataOwner();
        }
        genomicDataItems[dataId].currentOwner = nftOwner;
        _clearWorkers(dataId);
    }

    /**
     * @notice Callback from GenomicNFT._update on transfer (DEF2-1-05)
     * @param tokenId NFT token ID being transferred
     */
    function resetAuthorizedWorkersForToken(uint256 tokenId) external {
        if (msg.sender != address(genomicNFT)) revert NotDataOwner();
        uint256 dataId = tokenToDataId[tokenId];
        if (dataId != 0 && dataId <= dataCount) {
            resetAuthorizedWorkers(dataId);
        }
    }

    function _clearWorkers(uint256 dataId) internal {
        ++workerEpoch[dataId];
        address[] storage workers = _authorizedWorkersList[dataId];
        uint256 len = workers.length;
        for (uint256 i = 0; i < len; ) {
            address w = workers[i];
            if (authorizedCapsuleWorkers[dataId][w]) {
                authorizedCapsuleWorkers[dataId][w] = false;
                emit CapsuleWorkerAuthorized(dataId, w, false);
            }
            capsuleWorkerAuthorizer[dataId][w] = address(0);
            workerAuthorizedEpoch[dataId][w] = 0;
            delete _workerIndex[dataId][w];
            unchecked { ++i; }
        }
        delete _authorizedWorkersList[dataId];
    }

    /**
     * @notice Store buyer-specific re-encrypted key capsule (Proxy Re-Encryption support / RSA-OAEP)
     */
    function storeTransformedCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) external nonReentrant onlyDataOwnerOrDispatcher(dataId) {
        _deliverCapsule(dataId, researcher, capsule);
    }

    /**
     * @notice Capsule emission and storage: Persists capsule and emits CapsuleStored event
     * @param dataId Target dataset ID
     * @param researcher Target researcher address
     * @param capsule Serialized RSA-OAEP JSON key capsule
     */
    function emitTransformedCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) external nonReentrant onlyDataOwnerOrDispatcher(dataId) {
        _deliverCapsule(dataId, researcher, capsule);
        emit CapsuleStored(dataId, researcher, capsule);
    }

    function _deliverCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) internal {
        if (researcher == address(0)) revert InvalidAddress();
        if (genomicDataItems[dataId].status != DataStatus.Active) revert DataNotActive();
        if (bytes(capsule).length == 0) revert EmptyCapsule();

        EscrowDeposit storage deposit = escrowDeposits[dataId][researcher];
        GenomicData storage data = genomicDataItems[dataId];

        if (deposit.amount > 0) {
            if (deposit.released || deposit.refunded) revert EscrowNotActive();
            if (escrowDisputed[dataId][researcher]) revert EscrowDisputedError();
            uint256 deadline = deposit.depositTime + deposit.disputeWindow;
            if (block.timestamp >= deadline) revert DisputeWindowExpired();
            if (!deposit.capsuleDelivered && block.timestamp + 15 minutes > deadline) {
                deposit.disputeWindow = (block.timestamp - deposit.depositTime) + 15 minutes;
            }
        } else {
            _requireActiveGrant(dataId, researcher);
        }

        if (!_isValidCapsule(capsule)) revert InvalidCapsuleFormat();

        if (deposit.amount > 0) {
            AccessGrant storage grant = accessGrants[dataId][researcher];
            grant.isGranted = true;
            grant.grantedAt = block.timestamp;
            grant.expiresAt = block.timestamp + data.accessDuration;
            deposit.capsuleDelivered = true;
        }

        _buyerCapsules[dataId][researcher] = capsule;
    }

    function _requireActiveGrant(uint256 dataId, address researcher) internal view {
        AccessGrant storage grant = accessGrants[dataId][researcher];
        if (!grant.isGranted) revert AccessNotGranted();
        if (block.timestamp >= grant.expiresAt) revert AccessExpired();
    }

    function _requireBuyerActiveAccess(uint256 dataId, address user) internal view {
        if (escrowDisputed[dataId][user]) revert EscrowDisputedError();
        EscrowDeposit storage dep = escrowDeposits[dataId][user];
        if (dep.amount > 0 && (dep.refunded || !dep.capsuleDelivered)) revert AccessNotGranted();
        _requireActiveGrant(dataId, user);
    }

    /**
     * @notice Retrieve the re-encrypted capsule (only authorized researcher with active grant and active dataset)
     * @param dataId Target dataset ID
     * @return Serialized key capsule JSON string
     */
    function getTransformedCapsule(uint256 dataId) external view returns (string memory) {
        _requireValidDataId(dataId);
        if (genomicDataItems[dataId].status != DataStatus.Active) revert DataNotActive();
        _requireBuyerActiveAccess(dataId, msg.sender);
        return _buyerCapsules[dataId][msg.sender];
    }

    /**
     * @notice Data owner can view buyer's capsule
     * @param dataId Target dataset ID
     * @param researcher Target researcher address
     * @return Serialized key capsule JSON string
     */
    function getCapsuleForBuyer(uint256 dataId, address researcher) external view onlyDataOwner(dataId) returns (string memory) {
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();
        return _buyerCapsules[dataId][researcher];
    }

    /**
     * @notice Public view for buyer's capsule with caller authorization
     * @param dataId Target dataset ID
     * @param researcher Target researcher address
     * @return Serialized key capsule JSON string or empty string if unauthorized viewer
     */
    function buyerCapsules(uint256 dataId, address researcher) external view returns (string memory) {
        _requireValidDataId(dataId);
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status == DataStatus.Paused) revert DataNotActive();
        if (data.status != DataStatus.Active) return "";

        if (msg.sender == researcher) {
            _requireBuyerActiveAccess(dataId, researcher);
        } else {
            EscrowDeposit storage dep = escrowDeposits[dataId][researcher];
            bool escrowBlocked = (dep.amount > 0 && (dep.refunded || !dep.capsuleDelivered));
            if (escrowDisputed[dataId][researcher] || escrowBlocked) return "";
            AccessGrant storage grant = accessGrants[dataId][researcher];
            if (!grant.isGranted || block.timestamp >= grant.expiresAt) return "";
        }

        address nftOwner = _safeOwnerOf(data.tokenId, data.currentOwner);
        bool isWorker = isAuthorizedWorker(dataId, msg.sender);

        if (
            msg.sender == nftOwner ||
            msg.sender == capsuleDispatcher ||
            isWorker ||
            msg.sender == researcher
        ) {
            return _buyerCapsules[dataId][researcher];
        }
        return "";
    }

    /**
     * @notice Check whether an address has active permission to access a dataset
     * @param dataId Target dataset ID
     * @param researcher Address to verify
     * @return True if active access is currently permitted
     */
    function hasActiveAccess(uint256 dataId, address researcher) public view returns (bool) {
        _requireValidDataId(dataId);
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) return false;

        // The current NFT owner always has access to their own data
        if (_safeOwnerOf(data.tokenId, address(0)) == researcher) return true;

        if (escrowDisputed[dataId][researcher]) return false;

        EscrowDeposit storage deposit = escrowDeposits[dataId][researcher];
        if (deposit.amount > 0 && (deposit.refunded || !deposit.capsuleDelivered)) return false;

        AccessGrant storage grant = accessGrants[dataId][researcher];
        if (grant.isGranted && block.timestamp < grant.expiresAt) return true;

        return false;
    }

    function _getDatasetDonor(uint256 dataId) internal view returns (address) {
        _requireValidDataId(dataId);
        if (zkVerifier == address(0)) return address(0);
        return _safeOwnerOf(genomicDataItems[dataId].tokenId, genomicDataItems[dataId].currentOwner);
    }

    /**
     * @notice Check whether a registered dataset's owner has proven possession of a specific genomic trait via ZK-SNARKs
     * @param dataId Target genomic dataset identifier
     * @param traitId Identifier of the targeted genetic trait
     * @param variantCommitment Cryptographic commitment to the private genomic variant
     * @return verified True if the data owner has proven possession of the specific trait
     */
    function verifyDatasetTraitPossession(
        uint256 dataId,
        bytes32 traitId,
        bytes32 variantCommitment
    ) external view returns (bool verified) {
        address donor = _getDatasetDonor(dataId);
        return donor != address(0) && IGenomicZkVerifier(zkVerifier).hasVerifiedTraitVariant(traitId, variantCommitment, donor);
    }

    /**
     * @notice Check whether a registered dataset's owner has proven possession of a genomic trait via ZK-SNARKs
     * @param dataId Target genomic dataset identifier
     * @param variantCommitment Cryptographic commitment to the private genomic variant
     * @return verified True if the data owner has proven possession without revealing the raw genome
     */
    function verifyDatasetTraitPossession(uint256 dataId, bytes32 variantCommitment) external view returns (bool verified) {
        address donor = _getDatasetDonor(dataId);
        return donor != address(0) && IGenomicZkVerifier(zkVerifier).hasVerifiedVariant(variantCommitment, donor);
    }

    /**
     * @notice Check whether a donor has claimed a specific ZK genotype bounty verified by the linked Verifier
     * @param bountyId Target ZK bounty identifier
     * @param donor Target donor address
     * @return claimed True if the donor successfully claimed the bounty
     */
    function hasDonorClaimedZkBounty(uint256 bountyId, address donor) external view returns (bool claimed) {
        if (zkVerifier == address(0)) return false;
        return IGenomicZkVerifier(zkVerifier).hasClaimedBounty(bountyId, donor);
    }

    /**
     * @notice Get full details of a dataset
     */
    function getGenomicData(uint256 dataId) external view returns (GenomicData memory) {
        _requireValidDataId(dataId);
        GenomicData memory data = genomicDataItems[dataId];
        data.currentOwner = _safeOwnerOf(data.tokenId, data.currentOwner);
        return data;
    }

    /**
     * @notice Retrieve all registered genomic datasets (for marketplace catalog)
     */
    function getAllDataItems() external view returns (GenomicData[] memory) {
        (GenomicData[] memory items, ) = _paginate(0, dataCount);
        return items;
    }

    /**
     * @notice Retrieve registered genomic datasets with pagination
     * @param offset Starting index (0-indexed)
     * @param limit Maximum number of items to return
     */
    function getDataItemsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (GenomicData[] memory items, uint256 total)
    {
        return _paginate(offset, limit);
    }

    function _paginate(uint256 offset, uint256 limit)
        internal
        view
        returns (GenomicData[] memory items, uint256 total)
    {
        total = dataCount;
        if (offset >= total || limit == 0) {
            return (new GenomicData[](0), total);
        }
        uint256 remaining = total - offset;
        uint256 resultSize = limit > remaining ? remaining : limit;
        items = new GenomicData[](resultSize);
        for (uint256 i = 0; i < resultSize; ) {
            GenomicData storage stored = genomicDataItems[offset + i + 1];
            items[i] = stored;
            items[i].currentOwner = _safeOwnerOf(stored.tokenId, stored.currentOwner);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Rescue mistakenly sent ERC20 tokens to the registry contract.
     *         Cannot rescue paymentToken to prevent draining user escrow funds.
     * @param tokenAddress The ERC20 token address to rescue
     * @param to The recipient address
     * @param amount The token amount in wei
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner {
        if (tokenAddress == address(paymentToken)) revert CannotRescuePaymentToken();
        if (to == address(0)) revert InvalidRecipient();
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokensRescued(tokenAddress, to, amount);
    }

    /**
     * @notice Anchor summary report & GA4GH Phenopacket metadata SHA-256 hashes for an existing dataset
     */
    function anchorArtifactHashes(
        uint256 dataId,
        bytes32 summaryHash,
        bytes32 metadataHash
    ) external onlyDataOwner(dataId) {
        if (summaryHash == bytes32(0) || metadataHash == bytes32(0)) revert InvalidDataHashOrCid();
        if (summaryDataHashes[dataId] != bytes32(0) || metadataHashes[dataId] != bytes32(0)) {
            revert ArtifactHashesAlreadyAnchored();
        }
        summaryDataHashes[dataId] = summaryHash;
        metadataHashes[dataId] = metadataHash;
        emit ArtifactHashesAnchored(dataId, summaryHash, metadataHash);
    }

    /**
     * @notice Retrieve all 3 anchored cryptographic SHA-256 hashes (raw, summary, metadata)
     */
    function getArtifactHashes(uint256 dataId)
        external
        view
        returns (bytes32 rawDataHash, bytes32 summaryDataHash, bytes32 metadataHash)
    {
        _requireValidDataId(dataId);
        return (genomicDataItems[dataId].rawDataHash, summaryDataHashes[dataId], metadataHashes[dataId]);
    }

    /**
     * @notice Compute domain-separated salted keccak256 blind trait tag off-chain or on-chain
     */
    function computeBlindTag(
        string calldata traitKey,
        string calldata traitValue,
        bytes32 datasetSalt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode("GENOCHAIN_BLIND_TAG_V1", traitKey, traitValue, datasetSalt));
    }

    /**
     * @notice Replace or clear blinded trait search tags for a dataset (max 16 tags)
     */
    function setDatasetBlindTags(
        uint256 dataId,
        bytes32[] calldata blindTags
    ) external onlyDataOwner(dataId) {
        _setBlindTagsInternal(dataId, blindTags);
    }

    /**
     * @notice Serverless on-chain blind tag query enforcing Active lifecycle symmetry
     */
    function matchesBlindTag(uint256 dataId, bytes32 blindTag) external view returns (bool) {
        _requireValidDataId(dataId);
        if (genomicDataItems[dataId].status != DataStatus.Active) return false;
        return datasetBlindTags[dataId][blindTag];
    }

    /**
     * @notice Quote 5% follow-on study reuse fee (minimum 1 wei)
     */
    function quoteReuseFee(uint256 dataId) public view returns (uint256) {
        _requireValidDataId(dataId);
        uint256 fee = (genomicDataItems[dataId].price * REUSE_FEE_BPS) / 10_000;
        return fee < 1 ? 1 : fee;
    }

    /**
     * @notice Record a follow-on study reuse payment (5% fee with EIP-2981 secondary creator split)
     */
    function recordStudyReuse(uint256 dataId, bytes32 studyCommitment) external nonReentrant {
        _requireValidDataId(dataId);
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();
        address seller = _safeOwnerOf(data.tokenId, data.currentOwner);
        if (msg.sender == seller) revert SelfAccessNotAllowed();
        if (!hasActiveAccess(dataId, msg.sender)) {
            _requireBuyerActiveAccess(dataId, msg.sender);
            revert AccessNotGranted();
        }
        if (studyCommitment == bytes32(0)) revert InvalidStudyCommitment();
        if (studyReuseReceipts[dataId][studyCommitment]) revert StudyReuseAlreadyRecorded();

        uint256 reuseFee = quoteReuseFee(dataId);
        data.currentOwner = seller;
        studyReuseReceipts[dataId][studyCommitment] = true;
        ++datasetReuseCount[dataId];

        (, uint256 royaltyAmount) = _settleRoyaltyPayment(
            dataId,
            data.tokenId,
            msg.sender,
            seller,
            reuseFee
        );

        emit StudyReuseRecorded(dataId, msg.sender, studyCommitment, reuseFee, royaltyAmount);
    }

    function _transferToken(address from, address to, uint256 amount) internal {
        if (amount < 1) return;
        if (from == address(this)) {
            paymentToken.safeTransfer(to, amount);
        } else {
            paymentToken.safeTransferFrom(from, to, amount);
        }
    }

    function _settleRoyaltyPayment(
        uint256 dataId,
        uint256 tokenId,
        address from,
        address seller,
        uint256 totalPrice
    ) internal returns (uint256 sellerProceeds, uint256 royaltyAmount) {
        (address royaltyReceiver, uint256 rawRoyalty) = genomicNFT.royaltyInfo(tokenId, totalPrice);
        if (royaltyReceiver == address(0) || totalPrice < 1) {
            _transferToken(from, seller, totalPrice);
            return (totalPrice, 0);
        }
        if (rawRoyalty < 1 && royaltyReceiver != seller) {
            (address checkReceiver, uint256 bpsCheck) = genomicNFT.royaltyInfo(tokenId, 10_000);
            if (checkReceiver != address(0) && bpsCheck > 0) {
                rawRoyalty = 1;
            }
        }
        royaltyAmount = rawRoyalty > totalPrice ? totalPrice : rawRoyalty;
        sellerProceeds = totalPrice - royaltyAmount;
        if (royaltyReceiver == seller || royaltyAmount == 0) {
            _transferToken(from, seller, totalPrice);
        } else {
            _transferToken(from, royaltyReceiver, royaltyAmount);
            _transferToken(from, seller, sellerProceeds);
        }
        if (royaltyAmount > 0) {
            emit RoyaltyPaid(dataId, royaltyReceiver, royaltyAmount);
        }
    }

    function _setBlindTagsInternal(uint256 dataId, bytes32[] calldata blindTags) internal {
        uint256 len = blindTags.length;
        if (len > MAX_BLIND_TAGS_PER_DATASET) revert InvalidBlindTag();

        bytes32[] storage existing = _datasetBlindTagList[dataId];
        uint256 prevLen = existing.length;
        for (uint256 i = 0; i < prevLen; ) {
            datasetBlindTags[dataId][existing[i]] = false;
            unchecked {
                ++i;
            }
        }
        delete _datasetBlindTagList[dataId];

        for (uint256 i = 0; i < len; ) {
            bytes32 tag = blindTags[i];
            if (tag == bytes32(0) || datasetBlindTags[dataId][tag]) revert InvalidBlindTag();
            datasetBlindTags[dataId][tag] = true;
            existing.push(tag);
            emit BlindTagRegistered(dataId, tag);
            unchecked {
                ++i;
            }
        }
        datasetBlindTagCount[dataId] = len;
    }

    function _isValidCid(string calldata cid) internal pure returns (bool) {
        bytes calldata b = bytes(cid);
        uint256 len = b.length;
        if (len < 14 || len > 128) return false;
        if (b[0] == "Q" && b[1] == "m") {
            if (bytes4(b[2:6]) == "Geno") return false;
            for (uint256 i = 2; i < len; ) {
                bytes1 c = b[i];
                if (
                    !((c >= "1" && c <= "9") ||
                        (c >= "A" && c <= "Z" && c != "I" && c != "O") ||
                        (c >= "a" && c <= "z" && c != "l"))
                ) return false;
                unchecked { ++i; }
            }
            return true;
        }
        if (len >= 50 && bytes4(b[0:4]) == "bafy") {
            for (uint256 i = 4; i < len; ) {
                bytes1 c = b[i];
                if (!((c >= "a" && c <= "z") || (c >= "2" && c <= "7"))) return false;
                unchecked { ++i; }
            }
            return true;
        }
        return false;
    }

    function _isValidCapsule(string calldata capsule) internal pure returns (bool) {
        bytes calldata b = bytes(capsule);
        uint256 len = b.length;
        if (len < 528 || len > 8192) return false;

        uint8 st = 8; // 8=init, 0=key quote, 1=in key, 2=colon, 3=val, 4=in str, 5=in num, 6=comma/end, 7=closed
        uint256 spanStart = 0;
        bool esc = false;
        bool curKC = false;
        bool hasKC = false;
        bool numDigit = false;

        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            bool ws = (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d);
            if (st == 8) {
                if (!ws) {
                    if (c != "{") return false;
                    st = 0;
                }
            } else if (st == 0) {
                if (!ws) {
                    if (c != 0x22) return false;
                    spanStart = i + 1;
                    esc = false;
                    st = 1;
                }
            } else if (st == 1) {
                if (c < 0x20) return false;
                if (esc) {
                    esc = false;
                } else if (c == 0x5c) {
                    esc = true;
                } else if (c == 0x22) {
                    if (i == spanStart) return false;
                    curKC = keccak256(b[spanStart:i]) == keccak256("keyCipher");
                    st = 2;
                }
            } else if (st == 2) {
                if (!ws) {
                    if (c != ":") return false;
                    st = 3;
                }
            } else if (st == 3) {
                if (!ws) {
                    if (c == 0x22) {
                        spanStart = i + 1;
                        esc = false;
                        st = 4;
                    } else if (curKC) {
                        return false;
                    } else if ((c >= "0" && c <= "9") || c == "-") {
                        numDigit = (c >= "0" && c <= "9");
                        st = 5;
                    } else if (i + 4 <= len && (bytes4(b[i:i + 4]) == "true" || bytes4(b[i:i + 4]) == "null")) {
                        unchecked { i += 3; }
                        st = 6;
                    } else if (i + 5 <= len && bytes5(b[i:i + 5]) == "false") {
                        unchecked { i += 4; }
                        st = 6;
                    } else {
                        return false;
                    }
                }
            } else if (st == 4) {
                if (c < 0x20) return false;
                if (curKC) {
                    if (c == 0x22) {
                        uint256 hLen = i - spanStart;
                        if (hasKC || hLen < 512 || (hLen & 1) != 0) return false;
                        hasKC = true;
                        st = 6;
                    } else {
                        bytes1 ch = c | 0x20;
                        if (!((c >= "0" && c <= "9") || (ch >= "a" && ch <= "f"))) return false;
                    }
                } else if (esc) {
                    esc = false;
                } else if (c == 0x5c) {
                    esc = true;
                } else if (c == 0x22) {
                    st = 6;
                }
            } else if (st == 5) {
                if (c >= "0" && c <= "9") {
                    numDigit = true;
                } else if (c != "." && c != "e" && c != "E" && c != "+" && c != "-") {
                    if (!numDigit) return false;
                    if (ws) st = 6;
                    else if (c == ",") st = 0;
                    else if (c == "}") st = 7;
                    else return false;
                }
            } else if (st == 6) {
                if (!ws) {
                    if (c == ",") st = 0;
                    else if (c == "}") st = 7;
                    else return false;
                }
            } else if (!ws) {
                return false;
            }
            unchecked { ++i; }
        }
        return hasKC && st == 7 && !esc;
    }
}
