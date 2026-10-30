// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./GenomicNFT.sol";

/**
 * @title GenomicsRegistry
 * @author GenomicsBlockchainAgent
 * @notice Core registry contract for managing genomic data registration, access granting with escrow,
 *         status updates, and automatic EIP-2981 royalty disbursement.
 * @dev Fulfills all criteria of Bài tập 06 (Smart Contract + Escrow + Royalty + Security).
 */
contract GenomicsRegistry is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum DataStatus { Active, Paused, Revoked }

    struct GenomicData {
        uint256 dataId;
        uint256 tokenId;
        address currentOwner;
        bytes32 rawDataHash;         // [FIX P1] SHA-256 integrity hash of raw dataset
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

    // dataId => worker address => authorization status
    mapping(uint256 => mapping(address => bool)) public authorizedCapsuleWorkers;

    // dataId => worker address => authorizer owner address (DEF2-1-05)
    mapping(uint256 => mapping(address => address)) public capsuleWorkerAuthorizer;
    mapping(uint256 => address[]) internal _authorizedWorkersList;

    // tokenId => dataId
    mapping(uint256 => uint256) public tokenToDataId;

    // Custom Errors (Gas optimization)
    error NotDataOwner();
    error DataNotActive();
    error InvalidPrice();
    error InvalidDuration();
    error AccessAlreadyActive();
    error EscrowAlreadyActive();
    error OwnerCannotBuyOwnData();
    error EscrowTransferFailed();
    error RoyaltyTransferFailed();
    error DataNotFound();
    error InvalidDataHashOrCid();
    error DataAlreadyRegistered();
    error EmptyPublicKey();
    error InvalidRecipient();
    error EscrowNotActive();
    error DisputeWindowActive();
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

    // Events
    event ResearcherKeyRegistered(
        address indexed researcher,
        string publicKey
    );
    event CapsuleDispatcherUpdated(
        address indexed oldDispatcher,
        address indexed newDispatcher
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

    modifier onlyDataOwner(uint256 dataId) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        if (msg.sender != nftOwner) {
            revert NotDataOwner();
        }
        _;
    }

    modifier onlyDataOwnerOrDispatcher(uint256 dataId) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        bool isAuthorizedWorker = authorizedCapsuleWorkers[dataId][msg.sender] &&
            (capsuleWorkerAuthorizer[dataId][msg.sender] == nftOwner || capsuleWorkerAuthorizer[dataId][msg.sender] == address(0));
        if (
            msg.sender != nftOwner &&
            msg.sender != capsuleDispatcher &&
            !isAuthorizedWorker
        ) {
            revert NotDataOwner();
        }
        _;
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
    // Core Business Functions (Yêu cầu đề bài)
    // =========================================================================

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
        string memory rawCid,
        string memory summaryCid,
        string memory metadataCid,
        string memory tokenUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) external nonReentrant returns (uint256) {
        if (rawDataHash == bytes32(0) || bytes(rawCid).length == 0) revert InvalidDataHashOrCid();
        if (registeredRawDataHashes[rawDataHash]) revert DataAlreadyRegistered();
        if (price == 0) revert InvalidPrice();
        if (accessDuration == 0) revert InvalidDuration();

        registeredRawDataHashes[rawDataHash] = true;

        // Predict the exact token ID from GenomicNFT before minting
        uint256 expectedTokenId = genomicNFT.nextTokenId();
        dataCount++;
        uint256 newDataId = dataCount;

        // CHECKS-EFFECTS: Persist all state variables BEFORE triggering external interactions
        genomicDataItems[newDataId] = GenomicData({
            dataId: newDataId,
            tokenId: expectedTokenId,
            currentOwner: msg.sender,
            rawDataHash: rawDataHash,
            rawCiphertextCid: rawCid,
            summaryCiphertextCid: summaryCid,
            metadataCid: metadataCid,
            price: price,
            accessDuration: accessDuration,
            status: DataStatus.Active,
            accessCount: 0,
            registeredAt: block.timestamp
        });

        // INTERACTION: Mint Data Ownership NFT directly to contributor
        uint256 mintedTokenId = genomicNFT.mintGenomicNFT(
            msg.sender,
            tokenUri,
            rawDataHash,
            rawCid,
            summaryCid,
            metadataCid,
            royaltyBps
        );
        if (mintedTokenId != expectedTokenId) revert TokenIdMismatch();
        tokenToDataId[mintedTokenId] = newDataId;

        emit GenomicDataRegistered(newDataId, mintedTokenId, msg.sender, rawDataHash, price, metadataCid);
        return newDataId;
    }

    /**
     * @notice 2. grantAccess(): Researcher pays via Escrow and is granted time-locked access.
     *         Automatically deduces and pays EIP-2981 Royalty to original data creator!
     * @param dataId Target dataset ID to purchase access for
     */
    function grantAccess(uint256 dataId) external nonReentrant {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();

        address seller = genomicNFT.ownerOf(data.tokenId);
        if (msg.sender == seller) revert OwnerCannotBuyOwnData();

        AccessGrant storage grant = accessGrants[dataId][msg.sender];
        if (grant.isGranted && block.timestamp < grant.expiresAt) {
            revert AccessAlreadyActive();
        }

        EscrowDeposit storage existingDeposit = escrowDeposits[dataId][msg.sender];
        if (existingDeposit.amount > 0 && !existingDeposit.released && !existingDeposit.refunded) {
            revert EscrowAlreadyActive();
        }

        uint256 totalPrice = data.price;

        // Query EIP-2981 Royalty information on-chain
        (address royaltyReceiver, uint256 royaltyAmount) = genomicNFT.royaltyInfo(
            data.tokenId,
            totalPrice
        );

        uint256 sellerProceeds = totalPrice;
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            sellerProceeds = totalPrice - royaltyAmount;
        }

        // CHECKS-EFFECTS-INTERACTIONS: Update all state variables BEFORE making external calls
        uint256 expires = block.timestamp + data.accessDuration;
        data.accessCount++;
        data.currentOwner = seller; // Sync latest NFT holder

        accessGrants[dataId][msg.sender] = AccessGrant({
            isGranted: true,
            grantedAt: block.timestamp,
            expiresAt: expires
        });

        // Safe token transfers using SafeERC20 (prevents reentrancy & handles non-standard tokens)
        if (royaltyReceiver == seller) {
            // Gas optimization: Creator is selling their own data, single transfer of total price
            paymentToken.safeTransferFrom(msg.sender, seller, totalPrice);
            if (royaltyAmount > 0) {
                emit RoyaltyPaid(dataId, seller, royaltyAmount);
            }
        } else {
            // Secondary sale: Disburse royalty to creator, proceeds to secondary seller
            if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
                paymentToken.safeTransferFrom(msg.sender, royaltyReceiver, royaltyAmount);
                emit RoyaltyPaid(dataId, royaltyReceiver, royaltyAmount);
            }
            if (sellerProceeds > 0) {
                paymentToken.safeTransferFrom(msg.sender, seller, sellerProceeds);
            }
        }

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
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();

        address seller = genomicNFT.ownerOf(data.tokenId);
        if (msg.sender == seller) revert OwnerCannotBuyOwnData();

        AccessGrant storage grant = accessGrants[dataId][msg.sender];
        if (grant.isGranted && block.timestamp < grant.expiresAt) {
            revert AccessAlreadyActive();
        }

        EscrowDeposit storage existingDeposit = escrowDeposits[dataId][msg.sender];
        if (existingDeposit.amount > 0 && !existingDeposit.released && !existingDeposit.refunded) {
            if (block.timestamp < existingDeposit.depositTime + data.accessDuration) {
                revert AccessAlreadyActive();
            }
            revert EscrowAlreadyActive();
        }

        if (disputeWindow < 1 hours || disputeWindow > 30 days) revert InvalidDisputeWindow();

        uint256 totalPrice = data.price;
        data.accessCount++;
        data.currentOwner = seller;

        accessGrants[dataId][msg.sender] = AccessGrant({
            isGranted: false,
            grantedAt: 0,
            expiresAt: 0
        });

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

        paymentToken.safeTransferFrom(msg.sender, address(this), totalPrice);

        emit EscrowDeposited(dataId, msg.sender, totalPrice, disputeWindow);
    }

    /**
     * @notice Claim a 100% refund if the capsule dispatcher fails to deliver the capsule within the dispute window
     * @param dataId Target dataset ID
     */
    function claimEscrowRefund(uint256 dataId) external nonReentrant {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        EscrowDeposit storage deposit = escrowDeposits[dataId][msg.sender];
        if (bytes(_buyerCapsules[dataId][msg.sender]).length > 0 || deposit.released || deposit.capsuleDelivered) {
            revert CapsuleAlreadyDelivered();
        }
        if (deposit.amount == 0 || deposit.refunded) revert EscrowNotActive();

        bool canRefundImmediately = (genomicDataItems[dataId].status == DataStatus.Revoked || genomicDataItems[dataId].status == DataStatus.Paused);
        if (!canRefundImmediately && block.timestamp < deposit.depositTime + deposit.disputeWindow) {
            revert DisputeWindowActive();
        }

        uint256 refundAmount = deposit.amount;
        deposit.refunded = true;
        accessGrants[dataId][msg.sender].isGranted = false;
        accessGrants[dataId][msg.sender].expiresAt = 0;
        if (genomicDataItems[dataId].accessCount > 0) {
            genomicDataItems[dataId].accessCount--;
        }

        paymentToken.safeTransfer(msg.sender, refundAmount);
        emit EscrowRefunded(dataId, msg.sender, refundAmount);
    }

    /**
     * @notice Manually release escrowed payment to seller once capsule is verified/delivered
     * @param dataId Target dataset ID
     * @param buyer Target buyer address
     */
    function releaseEscrow(uint256 dataId, address buyer) external nonReentrant {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        EscrowDeposit storage deposit = escrowDeposits[dataId][buyer];
        if (deposit.amount == 0 || deposit.released || deposit.refunded) revert EscrowNotActive();
        if (!deposit.capsuleDelivered && bytes(_buyerCapsules[dataId][buyer]).length == 0) revert CapsuleNotDelivered();

        _releaseEscrowInternal(dataId, buyer);
    }

    /**
     * @dev Internal helper to disburse escrowed payment to seller and royalty to creator upon capsule delivery
     */
    function _releaseEscrowInternal(uint256 dataId, address buyer) internal {
        EscrowDeposit storage deposit = escrowDeposits[dataId][buyer];
        if (deposit.amount == 0 || deposit.released || deposit.refunded) {
            return;
        }

        GenomicData storage data = genomicDataItems[dataId];
        address seller = genomicNFT.ownerOf(data.tokenId);
        data.currentOwner = seller;
        uint256 totalPrice = deposit.amount;

        (address royaltyReceiver, uint256 royaltyAmount) = genomicNFT.royaltyInfo(
            data.tokenId,
            totalPrice
        );

        uint256 sellerProceeds = totalPrice;
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            sellerProceeds = totalPrice - royaltyAmount;
        }

        deposit.released = true;

        if (royaltyReceiver == seller) {
            paymentToken.safeTransfer(seller, totalPrice);
            if (royaltyAmount > 0) {
                emit RoyaltyPaid(dataId, seller, royaltyAmount);
            }
        } else {
            if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
                paymentToken.safeTransfer(royaltyReceiver, royaltyAmount);
                emit RoyaltyPaid(dataId, royaltyReceiver, royaltyAmount);
            }
            if (sellerProceeds > 0) {
                paymentToken.safeTransfer(seller, sellerProceeds);
            }
        }

        emit EscrowReleased(dataId, buyer, seller, sellerProceeds, royaltyAmount);
    }

    /**
     * @notice 3. updateDataStatus(): Change status of the dataset (Active, Paused, Revoked).
     *         Enforces Ràng buộc 1: Only data owner can execute!
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
     *         Enforces Ràng buộc 1: Only data owner can execute!
     * @param dataId Dataset ID
     * @param newPrice New price in $GENO wei
     */
    function updateDataPrice(uint256 dataId, uint256 newPrice) external onlyDataOwner(dataId) {
        if (newPrice == 0) revert InvalidPrice();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status == DataStatus.Revoked) revert ConsentPermanentlyRevoked();
        uint256 oldPrice = data.price;
        data.price = newPrice;

        emit DataPriceUpdated(dataId, oldPrice, newPrice);
    }

    /**
     * @notice grantDirectAccess(): Data Owner directly grants viewing access for a researcher/institution.
     *         Enforces Ràng buộc 1: Only data owner can execute!
     * @param dataId Dataset ID
     * @param recipient Researcher receiving access
     */
    function grantDirectAccess(uint256 dataId, address recipient) external onlyDataOwner(dataId) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (recipient == msg.sender) revert SelfAccessNotAllowed();
        GenomicData storage data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();

        AccessGrant storage currentGrant = accessGrants[dataId][recipient];
        bool hasActiveGrant = (currentGrant.isGranted && block.timestamp < currentGrant.expiresAt);
        if (!hasActiveGrant) {
            data.accessCount++;
        }

        uint256 expires = block.timestamp + data.accessDuration;

        accessGrants[dataId][recipient] = AccessGrant({
            isGranted: true,
            grantedAt: block.timestamp,
            expiresAt: expires
        });

        emit DirectAccessGranted(dataId, recipient, expires);
    }

    // =========================================================================
    // PRE Key Capsule & Access Query Helpers
    // =========================================================================

    /**
     * @notice Register persistent asymmetric public key (RSA-OAEP) for recipient key wrapping
     * @param publicKey Serialized JWK or SPKI representation of the researcher's public key
     */
    function registerResearcherPublicKey(string memory publicKey) external {
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
        authorizedCapsuleWorkers[dataId][worker] = authorized;
        if (authorized) {
            capsuleWorkerAuthorizer[dataId][worker] = msg.sender;
            _authorizedWorkersList[dataId].push(worker);
        } else {
            capsuleWorkerAuthorizer[dataId][worker] = address(0);
        }
        emit CapsuleWorkerAuthorized(dataId, worker, authorized);
    }

    /**
     * @notice Reset authorized capsule workers when NFT ownership changes (DEF2-1-05)
     * @param dataId Target dataset ID
     */
    function resetAuthorizedWorkers(uint256 dataId) public {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        address nftOwner = genomicNFT.ownerOf(genomicDataItems[dataId].tokenId);
        if (msg.sender != address(genomicNFT) && msg.sender != nftOwner && msg.sender != owner()) {
            revert NotDataOwner();
        }
        address[] storage workers = _authorizedWorkersList[dataId];
        for (uint256 i = 0; i < workers.length; i++) {
            authorizedCapsuleWorkers[dataId][workers[i]] = false;
            capsuleWorkerAuthorizer[dataId][workers[i]] = address(0);
        }
        delete _authorizedWorkersList[dataId];
    }

    /**
     * @notice Callback from GenomicNFT._update on transfer (DEF2-1-05)
     * @param tokenId NFT token ID being transferred
     */
    function resetAuthorizedWorkersForToken(uint256 tokenId) external {
        if (msg.sender != address(genomicNFT)) revert NotDataOwner();
        uint256 dataId = tokenToDataId[tokenId];
        if (dataId == 0 && tokenId <= dataCount && genomicDataItems[tokenId].tokenId == tokenId) {
            dataId = tokenId;
        }
        if (dataId != 0 && dataId <= dataCount) {
            address[] storage workers = _authorizedWorkersList[dataId];
            for (uint256 i = 0; i < workers.length; i++) {
                authorizedCapsuleWorkers[dataId][workers[i]] = false;
                capsuleWorkerAuthorizer[dataId][workers[i]] = address(0);
            }
            delete _authorizedWorkersList[dataId];
        }
    }

    /**
     * @notice Store buyer-specific re-encrypted key capsule (Proxy Re-Encryption support / RSA-OAEP)
     *         Callable by the current Data Owner, the authorized Capsule Dispatcher, or an authorized worker
     * @param dataId Dataset ID
     * @param researcher Researcher address
     * @param capsule Serialized PRE capsule or ephemeral encryption payload
     */
    function storeTransformedCapsule(
        uint256 dataId,
        address researcher,
        string memory capsule
    ) external onlyDataOwnerOrDispatcher(dataId) {
        if (researcher == address(0)) revert InvalidAddress();
        if (genomicDataItems[dataId].status != DataStatus.Active) revert DataNotActive();
        if (bytes(capsule).length == 0) revert EmptyCapsule();

        EscrowDeposit storage deposit = escrowDeposits[dataId][researcher];
        GenomicData storage data = genomicDataItems[dataId];

        if (deposit.amount > 0) {
            if (deposit.released || deposit.refunded) revert EscrowNotActive();
            accessGrants[dataId][researcher].isGranted = true;
            accessGrants[dataId][researcher].grantedAt = block.timestamp;
            accessGrants[dataId][researcher].expiresAt = block.timestamp + data.accessDuration;
            deposit.capsuleDelivered = true;
        } else {
            AccessGrant memory grant = accessGrants[dataId][researcher];
            if (!grant.isGranted) revert AccessNotGranted();
            if (block.timestamp >= grant.expiresAt) revert AccessExpired();
        }

        _buyerCapsules[dataId][researcher] = capsule;
        emit CapsuleStored(dataId, researcher, capsule);

        if (
            deposit.amount > 0 &&
            !deposit.released &&
            !deposit.refunded
        ) {
            _releaseEscrowInternal(dataId, researcher);
        }
    }

    /**
     * @notice Gas-optimized capsule emission: Emits CapsuleStored event without SSTORE gas cost (~550k gas saved)
     *         Client retrieves capsule from EVM receipt logs (CapsuleStored event filter).
     * @param dataId Dataset ID
     * @param researcher Researcher address
     * @param capsule Serialized PRE capsule or ephemeral encryption payload
     */
    function emitTransformedCapsule(
        uint256 dataId,
        address researcher,
        string calldata capsule
    ) external onlyDataOwnerOrDispatcher(dataId) {
        if (researcher == address(0)) revert InvalidAddress();
        if (genomicDataItems[dataId].status != DataStatus.Active) revert DataNotActive();
        if (bytes(capsule).length == 0) revert EmptyCapsule();

        EscrowDeposit storage deposit = escrowDeposits[dataId][researcher];
        GenomicData storage data = genomicDataItems[dataId];

        if (deposit.amount > 0) {
            if (deposit.released || deposit.refunded) revert EscrowNotActive();
            accessGrants[dataId][researcher].isGranted = true;
            accessGrants[dataId][researcher].grantedAt = block.timestamp;
            accessGrants[dataId][researcher].expiresAt = block.timestamp + data.accessDuration;
            deposit.capsuleDelivered = true;
        } else {
            AccessGrant memory grant = accessGrants[dataId][researcher];
            if (!grant.isGranted) revert AccessNotGranted();
            if (block.timestamp >= grant.expiresAt) revert AccessExpired();
        }

        emit CapsuleStored(dataId, researcher, capsule);

        if (
            deposit.amount > 0 &&
            !deposit.released &&
            !deposit.refunded
        ) {
            _releaseEscrowInternal(dataId, researcher);
        }
    }

    /**
     * @notice Retrieve the re-encrypted capsule (only authorized researcher with active grant and active dataset)
     */
    function getTransformedCapsule(uint256 dataId) external view returns (string memory) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData memory data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();

        AccessGrant memory grant = accessGrants[dataId][msg.sender];
        if (!grant.isGranted) revert AccessNotGranted();
        if (block.timestamp >= grant.expiresAt) revert AccessExpired();
        return _buyerCapsules[dataId][msg.sender];
    }

    /**
     * @notice Data owner can view buyer's capsule
     */
    function getCapsuleForBuyer(uint256 dataId, address researcher) external view onlyDataOwner(dataId) returns (string memory) {
        GenomicData memory data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) revert DataNotActive();
        return _buyerCapsules[dataId][researcher];
    }

    /**
     * @notice Public view for buyer's capsule with caller authorization
     * @param dataId Target dataset ID
     * @param researcher Target researcher address
     */
    function buyerCapsules(uint256 dataId, address researcher) external view returns (string memory) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData memory data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) return "";

        if (msg.sender == researcher) {
            AccessGrant memory grant = accessGrants[dataId][researcher];
            if (!grant.isGranted) revert AccessNotGranted();
            if (block.timestamp >= grant.expiresAt) revert AccessExpired();
        }

        address nftOwner = genomicNFT.ownerOf(data.tokenId);
        bool isAuthorizedWorker = authorizedCapsuleWorkers[dataId][msg.sender] &&
            (capsuleWorkerAuthorizer[dataId][msg.sender] == nftOwner || capsuleWorkerAuthorizer[dataId][msg.sender] == address(0));

        if (
            msg.sender == nftOwner ||
            msg.sender == capsuleDispatcher ||
            isAuthorizedWorker ||
            msg.sender == researcher
        ) {
            return _buyerCapsules[dataId][researcher];
        }
        return "";
    }

    /**
     * @notice Check whether an address has active permission to access a dataset
     */
    function hasActiveAccess(uint256 dataId, address researcher) external view returns (bool) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData memory data = genomicDataItems[dataId];
        if (data.status != DataStatus.Active) return false;

        // The current NFT owner always has access to their own data
        if (genomicNFT.ownerOf(data.tokenId) == researcher) return true;

        AccessGrant memory grant = accessGrants[dataId][researcher];
        if (grant.isGranted && block.timestamp < grant.expiresAt) return true;

        EscrowDeposit memory deposit = escrowDeposits[dataId][researcher];
        if (deposit.amount > 0 && !deposit.released && !deposit.refunded) {
            return true;
        }

        return false;
    }

    /**
     * @notice Get full details of a dataset
     */
    function getGenomicData(uint256 dataId) external view returns (GenomicData memory) {
        if (dataId == 0 || dataId > dataCount) revert DataNotFound();
        GenomicData memory data = genomicDataItems[dataId];
        data.currentOwner = genomicNFT.ownerOf(data.tokenId);
        return data;
    }

    /**
     * @notice Retrieve all registered genomic datasets (for marketplace catalog)
     */
    function getAllDataItems() external view returns (GenomicData[] memory) {
        GenomicData[] memory items = new GenomicData[](dataCount);
        for (uint256 i = 1; i <= dataCount; i++) {
            items[i - 1] = genomicDataItems[i];
            items[i - 1].currentOwner = genomicNFT.ownerOf(items[i - 1].tokenId);
        }
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
        total = dataCount;
        if (offset >= total || limit == 0) {
            return (new GenomicData[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        uint256 resultSize = end - offset;
        items = new GenomicData[](resultSize);
        for (uint256 i = 0; i < resultSize; i++) {
            items[i] = genomicDataItems[offset + i + 1];
            items[i].currentOwner = genomicNFT.ownerOf(items[i].tokenId);
        }
        return (items, total);
    }
}
