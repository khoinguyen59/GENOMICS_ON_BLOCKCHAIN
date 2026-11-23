// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IGenomicsMetadataErrors } from "../interfaces/IGenomicsMetadataErrors.sol";
import { IGenomicZkVerifier } from "../interfaces/IGenomicZkVerifier.sol";
import { GenomicNFT } from "../GenomicNFT.sol";
import { GenomicsRegistryStorage } from "./GenomicsRegistryStorage.sol";

/**
 * @title GenomicsMetadataStore
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Dedicated non-custodial catalog, metadata index, and ZK view-bridge module deployed by GenomicsRegistry.
 * @dev Isolates compact GenomicDataCore catalog records, catalog hydration/pagination, researcher public keys,
 *      O(1) worker authorization epochs, 3-artifact SHA-256 hash anchors, blinded trait tags, study reuse receipts,
 *      and anti-front-running commit-reveal commitments from the financial escrow core with zero delegatecall surface.
 */
contract GenomicsMetadataStore is IGenomicsMetadataErrors {
    /// @notice Packed worker authorization record fitting in a single storage slot.
    struct WorkerAuth {
        bool authorized;
        address authorizer;
    }

    /// @notice Paired off-chain SHA-256 artifact hash anchors (clinical summary PDF + GA4GH Phenopacket JSON).
    struct ArtifactHashes {
        bytes32 summaryHash;
        bytes32 metadataHash;
    }

    /// @notice Bounded blind tag list container per dataset.
    struct BlindTagList {
        bytes32[] list;
    }

    /// @notice Maximum number of blinded keccak-256 search tags permitted per genomic dataset.
    uint256 public constant MAX_BLIND_TAGS_PER_DATASET = 16;
    /// @notice Follow-on study reuse fee rate in basis points (500 = 5%).
    uint256 public constant REUSE_FEE_BPS = 500;
    /// @notice Maximum permitted access duration (365 days).
    uint256 public constant MAX_ACCESS_DURATION = 365 days;
    /// @notice Maximum permitted dataset license price (100M $GENO).
    uint256 public constant MAX_PRICE = 100_000_000 ether;

    /// @notice Immutable address of the owning GenomicsRegistry contract.
    address private immutable REGISTRY;
    /// @notice Immutable address of the linked GenomicNFT contract.
    GenomicNFT private immutable GENOMIC_NFT;

    /// @notice Total mirrored dataset count for catalog pagination and bounds checks.
    uint256 public itemCount;

    /// @notice Dataset ID to compact GenomicDataCore record (CIDs resolved canonically from GenomicNFT).
    mapping(uint256 => GenomicsRegistryStorage.GenomicDataCore) private _items;

    /// @notice Researcher address to serialized RSA-OAEP public key (JWK or SPKI).
    mapping(address => string) public researcherPublicKeys;

    /// @notice Dataset ID to O(1) worker authorization revocation epoch counter.
    mapping(uint256 => uint256) public workerEpoch;

    /// @notice Dataset ID => epoch => worker => packed authorization + authorizer record.
    mapping(uint256 => mapping(uint256 => mapping(address => WorkerAuth))) private _workersByEpoch;

    /// @notice Dataset ID to anchored summary & metadata SHA-256 hashes.
    mapping(uint256 => ArtifactHashes) private _artifactHashes;

    /// @notice Dataset ID => blinded keccak-256 tag => presence flag.
    mapping(uint256 => mapping(bytes32 => bool)) private _datasetBlindTags;

    /// @notice Dataset ID to bounded list of registered blinded tags for O(tags) replacement.
    mapping(uint256 => BlindTagList) private _datasetBlindTagLists;

    /// @notice Salted commit key to commit block number for anti-front-running registration.
    mapping(bytes32 => uint256) public registrationCommitments;

    /// @notice Flag indicating whether strict commit-reveal registration mode is enforced.
    bool public commitRevealRequired;

    /// @notice Dataset ID => studyCommitment => recorded flag (globally unique per dataset to prevent replay).
    mapping(uint256 => mapping(bytes32 => bool)) public studyReuseReceipts;

    /// @notice Dataset ID to cumulative count of settled follow-on study reuses.
    mapping(uint256 => uint256) public datasetReuseCount;

    /// @notice Linked GenomicZkVerifier contract address for zero-knowledge trait proofs.
    address public zkVerifier;

    /// @notice Thrown when a non-registry caller invokes a mutating function.
    error NotDataOwner();
    /// @notice Thrown when a zero address is passed for a worker or recipient.
    error InvalidRecipient();
    /// @notice Thrown when an artifact hash anchor is zero.
    error InvalidDataHashOrCid();
    /// @notice Thrown when dataId is zero or exceeds itemCount.
    error DataNotFound();
    /// @notice Thrown when an operation requires DataStatus.Active.
    error DataNotActive();

    modifier onlyRegistry() {
        if (msg.sender != REGISTRY) revert NotDataOwner();
        _;
    }

    /**
     * @notice Bind this auxiliary store permanently to its deploying GenomicsRegistry and GenomicNFT.
     * @param _genomicNFT Address of the linked GenomicNFT contract.
     */
    constructor(address _genomicNFT) {
        if (_genomicNFT == address(0)) revert InvalidRecipient();
        REGISTRY = msg.sender;
        GENOMIC_NFT = GenomicNFT(_genomicNFT);
    }

    /**
     * @notice Return the owning GenomicsRegistry address.
     * @return registryAddr Address of the owning GenomicsRegistry contract.
     */
    function registry() external view returns (address registryAddr) {
        return REGISTRY;
    }

    // =========================================================================
    // Catalog Core CRUD & Hydrated Views
    // =========================================================================

    /**
     * @notice Create a new compact GenomicDataCore catalog record.
     * @param dataId Assigned dataset identifier.
     * @param tokenId Linked GenomicNFT token identifier.
     * @param ownerAddr Initial dataset owner address.
     * @param rawDataHash Anchored SHA-256 hash of encrypted raw package.
     * @param price License price in $GENO wei.
     * @param accessDuration License duration in seconds.
     */
    function createItem(
        uint256 dataId,
        uint256 tokenId,
        address ownerAddr,
        bytes32 rawDataHash,
        uint256 price,
        uint256 accessDuration
    ) external onlyRegistry {
        if (price == 0 || price > MAX_PRICE) revert InvalidPrice();
        if (accessDuration == 0 || accessDuration > MAX_ACCESS_DURATION) revert InvalidDuration();
        itemCount = dataId;
        GenomicsRegistryStorage.GenomicDataCore storage item = _items[dataId];
        item.tokenId = tokenId;
        item.currentOwner = ownerAddr;
        item.status = GenomicsRegistryStorage.DataStatus.Active;
        item.rawDataHash = rawDataHash;
        item.price = price;
        item.accessDuration = accessDuration;
        item.registeredAt = block.timestamp;
    }

    /**
     * @notice Return compact execution fields for GenomicsRegistry without copying CIDs or unused metadata.
     * @param dataId Dataset identifier.
     * @return tokenId Linked GenomicNFT token identifier.
     * @return currentOwner Stored owner address.
     * @return price License price in $GENO wei.
     * @return accessDuration License duration in seconds.
     * @return status Current DataStatus lifecycle value.
     */
    function getItemMeta(uint256 dataId)
        external
        view
        returns (
            uint256 tokenId,
            address currentOwner,
            uint256 price,
            uint256 accessDuration,
            GenomicsRegistryStorage.DataStatus status
        )
    {
        GenomicsRegistryStorage.GenomicDataCore storage c = _items[dataId];
        return (c.tokenId, c.currentOwner, c.price, c.accessDuration, c.status);
    }

    /**
     * @notice Update cached currentOwner address on a catalog item.
     * @param dataId Dataset identifier.
     * @param newOwner Updated ERC-721 owner address.
     */
    function setItemOwner(uint256 dataId, address newOwner) external onlyRegistry {
        _items[dataId].currentOwner = newOwner;
    }

    /**
     * @notice Update lifecycle DataStatus on a catalog item.
     * @param dataId Dataset identifier.
     * @param newStatus Target DataStatus enum value.
     */
    function setItemStatus(uint256 dataId, GenomicsRegistryStorage.DataStatus newStatus) external onlyRegistry {
        _items[dataId].status = newStatus;
    }

    /**
     * @notice Update access license fee on a catalog item.
     * @param dataId Dataset identifier.
     * @param newPrice Updated price in $GENO wei.
     * @return oldPrice Previous price in $GENO wei.
     */
    function setItemPrice(uint256 dataId, uint256 newPrice) external onlyRegistry returns (uint256 oldPrice) {
        if (newPrice == 0 || newPrice > MAX_PRICE) revert InvalidPrice();
        GenomicsRegistryStorage.GenomicDataCore storage item = _items[dataId];
        if (item.status != GenomicsRegistryStorage.DataStatus.Active) revert DataNotActive();
        oldPrice = item.price;
        item.price = newPrice;
    }

    /**
     * @notice Increment or safely decrement cumulative accessCount and optionally sync cached owner.
     * @param dataId Dataset identifier.
     * @param increment True to increment accessCount, false to decrement if > 0.
     * @param syncedOwner Non-zero owner address to cache (or address(0) to leave unchanged).
     */
    function adjustAccessCount(uint256 dataId, bool increment, address syncedOwner) external onlyRegistry {
        GenomicsRegistryStorage.GenomicDataCore storage item = _items[dataId];
        if (increment) {
            unchecked {
                ++item.accessCount;
            }
        } else if (item.accessCount > 0) {
            unchecked {
                --item.accessCount;
            }
        }
        if (syncedOwner != address(0)) item.currentOwner = syncedOwner;
    }

    function _hydrate(uint256 id, bool syncOwner) internal view returns (GenomicsRegistryStorage.GenomicData memory item) {
        GenomicsRegistryStorage.GenomicDataCore storage core = _items[id];
        if (core.tokenId == 0) return item;
        (string memory rawCid, string memory summaryCid, string memory metaCid, address liveOwner) =
            GENOMIC_NFT.recordCidsAndOwner(core.tokenId);
        item.dataId = id;
        item.tokenId = core.tokenId;
        item.currentOwner = (syncOwner && liveOwner != address(0)) ? liveOwner : core.currentOwner;
        item.rawDataHash = core.rawDataHash;
        item.rawCiphertextCid = rawCid;
        item.summaryCiphertextCid = summaryCid;
        item.metadataCid = metaCid;
        item.price = core.price;
        item.accessDuration = core.accessDuration;
        item.status = core.status;
        item.accessCount = core.accessCount;
        item.registeredAt = core.registeredAt;
    }

    /**
     * @notice ABI-compatible flat tuple getter mirroring GenomicsRegistry.genomicDataItems(uint256).
     * @param id Dataset identifier.
     * @return dataId Dataset identifier.
     * @return tokenId Linked NFT token ID.
     * @return currentOwner Stored owner address.
     * @return rawDataHash Anchored encrypted raw SHA-256 hash.
     * @return rawCiphertextCid IPFS CID of encrypted raw file.
     * @return summaryCiphertextCid IPFS CID of encrypted summary PDF.
     * @return metadataCid IPFS CID of public GA4GH Phenopacket JSON.
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
            GenomicsRegistryStorage.DataStatus status,
            uint256 accessCount,
            uint256 registeredAt
        )
    {
        GenomicsRegistryStorage.GenomicData memory d = _hydrate(id, false);
        return (
            d.dataId,
            d.tokenId,
            d.currentOwner,
            d.rawDataHash,
            d.rawCiphertextCid,
            d.summaryCiphertextCid,
            d.metadataCid,
            d.price,
            d.accessDuration,
            d.status,
            d.accessCount,
            d.registeredAt
        );
    }

    /**
     * @notice Retrieve full hydrated GenomicData struct with live ERC-721 ownership synced.
     * @param dataId Dataset identifier.
     * @return item Hydrated GenomicData struct.
     */
    function getGenomicData(uint256 dataId) external view returns (GenomicsRegistryStorage.GenomicData memory item) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        return _hydrate(dataId, true);
    }

    /**
     * @notice Retrieve all registered genomic datasets with live ERC-721 ownership synced.
     * @return items Array of all GenomicData structs.
     */
    function getAllDataItems() external view returns (GenomicsRegistryStorage.GenomicData[] memory items) {
        (items, ) = _paginate(0, itemCount);
    }

    /**
     * @notice Retrieve paginated registered genomic datasets with live ERC-721 ownership synced.
     * @param offset Zero-based starting offset.
     * @param limit Maximum records to return.
     * @return items Paginated GenomicData array.
     * @return total Total registered dataset count.
     */
    function getDataItemsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (GenomicsRegistryStorage.GenomicData[] memory items, uint256 total)
    {
        return _paginate(offset, limit);
    }

    function _paginate(uint256 offset, uint256 limit)
        internal
        view
        returns (GenomicsRegistryStorage.GenomicData[] memory items, uint256 total)
    {
        total = itemCount;
        if (!(offset < total) || limit == 0) return (new GenomicsRegistryStorage.GenomicData[](0), total);
        uint256 remaining = total - offset;
        uint256 resultSize = limit > remaining ? remaining : limit;
        items = new GenomicsRegistryStorage.GenomicData[](resultSize);
        for (uint256 i = 0; i < resultSize; ) {
            items[i] = _hydrate(offset + i + 1, true);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Quote 5% follow-on study reuse fee (minimum 1 wei).
     * @param dataId Dataset identifier.
     * @return fee Reuse fee in $GENO wei.
     */
    function quoteReuseFee(uint256 dataId) external view returns (uint256 fee) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        fee = (_items[dataId].price * REUSE_FEE_BPS) / 10_000;
        if (fee < 1) fee = 1;
    }

    // =========================================================================
    // Commit-Reveal, Keys, Workers, Artifacts, Blind Tags, Study Reuse & ZK
    // =========================================================================

    /**
     * @notice Toggle strict commit-reveal registration requirement.
     * @param required True to require commit-reveal before dataset registration.
     */
    function setCommitRevealRequired(bool required) external onlyRegistry {
        commitRevealRequired = required;
    }

    /**
     * @notice Revert with CommitmentNotFound if strict commit-reveal registration mode is active.
     */
    function requireDirectRegistrationAllowed() external view {
        if (commitRevealRequired) revert CommitmentNotFound();
    }

    /**
     * @notice Record a salted dataset registration commitment for a donor.
     * @param commitment Salted hash commitment binding rawDataHash, salt, and donor address.
     * @param donor Donor wallet submitting the commitment.
     * @return committedBlock Block number recorded for the commitment.
     */
    function commitGenomicData(bytes32 commitment, address donor) external onlyRegistry returns (uint256 committedBlock) {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        bytes32 commitKey = keccak256(abi.encodePacked(commitment, donor));
        if (registrationCommitments[commitKey] != 0) revert CommitmentAlreadyExists();
        committedBlock = block.number;
        registrationCommitments[commitKey] = committedBlock;
    }

    /**
     * @notice Verify and consume a previously committed registration hash in a subsequent block.
     * @param rawDataHash SHA-256 hash of the encrypted raw genomic package.
     * @param salt Random 32-byte blinding salt used during commitment.
     * @param donor Donor wallet revealing the commitment.
     */
    function consumeCommitment(bytes32 rawDataHash, bytes32 salt, address donor) external onlyRegistry {
        bytes32 inner = keccak256(abi.encodePacked(rawDataHash, salt, donor));
        bytes32 commitKey = keccak256(abi.encodePacked(inner, donor));
        uint256 commitBlock = registrationCommitments[commitKey];
        // slither-disable-next-line incorrect-equality
        if (commitBlock == 0) revert CommitmentNotFound();
        if (!(commitBlock < block.number)) revert CommitmentTooNew();
        delete registrationCommitments[commitKey];
    }

    /**
     * @notice Persist a researcher's serialized RSA-OAEP public key.
     * @param researcher Researcher wallet address.
     * @param publicKey Serialized JWK or SPKI public key string (1..4096 bytes).
     */
    function setResearcherPublicKey(address researcher, string calldata publicKey) external onlyRegistry {
        uint256 len = bytes(publicKey).length;
        if (len == 0) revert EmptyPublicKey();
        if (len > 4096) revert InvalidCapsuleFormat();
        researcherPublicKeys[researcher] = publicKey;
    }

    /**
     * @notice Return keccak256 hash and non-empty presence flag of a researcher's registered public key.
     * @param researcher Researcher wallet address.
     * @return keyHash Keccak-256 hash of the stored public key string.
     * @return hasKey True if a non-empty public key is currently registered.
     */
    function getResearcherPubKeyState(address researcher) external view returns (bytes32 keyHash, bool hasKey) {
        bytes memory pk = bytes(researcherPublicKeys[researcher]);
        return (keccak256(pk), pk.length > 0);
    }

    /**
     * @notice Authorize or revoke a third-party capsule worker in the active epoch for a dataset.
     * @param dataId Dataset identifier.
     * @param worker Worker wallet address.
     * @param authorized True to authorize, false to revoke.
     * @param authorizer Current NFT owner granting the authorization.
     */
    function setAuthorizedWorker(
        uint256 dataId,
        address worker,
        bool authorized,
        address authorizer
    ) external onlyRegistry {
        if (worker == address(0)) revert InvalidRecipient();
        uint256 ep = workerEpoch[dataId];
        _workersByEpoch[dataId][ep][worker] = WorkerAuth({
            authorized: authorized,
            authorizer: authorized ? authorizer : address(0)
        });
    }

    /**
     * @notice Check whether a worker is authorized under the current epoch and current live NFT owner.
     * @param dataId Dataset identifier.
     * @param worker Worker wallet address.
     * @return authorized True if authorized by the live NFT owner in the current epoch.
     */
    function isAuthorizedWorker(uint256 dataId, address worker) public view returns (bool authorized) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        address currentNftOwner = GENOMIC_NFT.ownerOf(_items[dataId].tokenId);
        WorkerAuth storage rec = _workersByEpoch[dataId][workerEpoch[dataId]][worker];
        return rec.authorized && rec.authorizer == currentNftOwner;
    }

    /**
     * @notice ABI-compatible alias for `authorizedCapsuleWorkers(uint256,address)`.
     * @param dataId Dataset identifier.
     * @param worker Worker wallet address.
     * @return authorized True if authorized by the live NFT owner in the current epoch.
     */
    function authorizedCapsuleWorkers(uint256 dataId, address worker) external view returns (bool authorized) {
        return isAuthorizedWorker(dataId, worker);
    }

    /**
     * @notice Return the authorizer address for an active worker under the live NFT owner, or zero if unauthorized.
     * @param dataId Dataset identifier.
     * @param worker Worker wallet address.
     * @return authorizer Address that authorized the worker, or `address(0)`.
     */
    function capsuleWorkerAuthorizer(uint256 dataId, address worker) external view returns (address authorizer) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        address currentNftOwner = GENOMIC_NFT.ownerOf(_items[dataId].tokenId);
        WorkerAuth storage rec = _workersByEpoch[dataId][workerEpoch[dataId]][worker];
        return (rec.authorized && rec.authorizer == currentNftOwner) ? rec.authorizer : address(0);
    }

    /**
     * @notice Invalidate all authorized workers for a dataset in O(1) by incrementing its worker epoch.
     * @param dataId Dataset identifier.
     */
    function incrementWorkerEpoch(uint256 dataId) external onlyRegistry {
        unchecked {
            ++workerEpoch[dataId];
        }
    }

    /**
     * @notice Anchor summary PDF and GA4GH Phenopacket JSON SHA-256 hashes for a dataset.
     * @param dataId Dataset identifier.
     * @param summaryHash Non-zero SHA-256 hash of encrypted summary report.
     * @param metadataHash Non-zero SHA-256 hash of public Phenopacket JSON.
     * @param requireUnanchored When true, reverts if hashes were previously anchored.
     */
    function anchorArtifactHashes(
        uint256 dataId,
        bytes32 summaryHash,
        bytes32 metadataHash,
        bool requireUnanchored
    ) external onlyRegistry {
        if (summaryHash == bytes32(0) || metadataHash == bytes32(0)) revert InvalidDataHashOrCid();
        ArtifactHashes storage ah = _artifactHashes[dataId];
        if (requireUnanchored && (ah.summaryHash != bytes32(0) || ah.metadataHash != bytes32(0))) {
            revert ArtifactHashesAlreadyAnchored();
        }
        ah.summaryHash = summaryHash;
        ah.metadataHash = metadataHash;
    }

    /**
     * @notice Return anchored SHA-256 hash of encrypted clinical summary PDF.
     * @param dataId Dataset identifier.
     * @return hash Anchored summary SHA-256 hash.
     */
    function summaryDataHashes(uint256 dataId) external view returns (bytes32 hash) {
        return _artifactHashes[dataId].summaryHash;
    }

    /**
     * @notice Return anchored SHA-256 hash of public GA4GH Phenopacket JSON.
     * @param dataId Dataset identifier.
     * @return hash Anchored metadata SHA-256 hash.
     */
    function metadataHashes(uint256 dataId) external view returns (bytes32 hash) {
        return _artifactHashes[dataId].metadataHash;
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
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        ArtifactHashes storage ah = _artifactHashes[dataId];
        return (_items[dataId].rawDataHash, ah.summaryHash, ah.metadataHash);
    }

    /**
     * @notice Replace or clear blinded trait search tags for a dataset (bounded by MAX_BLIND_TAGS_PER_DATASET).
     * @param dataId Dataset identifier.
     * @param blindTags Unique non-zero blinded tag hashes.
     */
    function setBlindTags(uint256 dataId, bytes32[] calldata blindTags) external onlyRegistry {
        uint256 len = blindTags.length;
        if (len > MAX_BLIND_TAGS_PER_DATASET) revert InvalidBlindTag();

        bytes32[] storage existing = _datasetBlindTagLists[dataId].list;
        uint256 prevLen = existing.length;
        for (uint256 i = 0; i < prevLen; ) {
            _datasetBlindTags[dataId][existing[i]] = false;
            unchecked {
                ++i;
            }
        }
        delete _datasetBlindTagLists[dataId].list;

        for (uint256 i = 0; i < len; ) {
            bytes32 tag = blindTags[i];
            if (tag == bytes32(0) || _datasetBlindTags[dataId][tag]) revert InvalidBlindTag();
            _datasetBlindTags[dataId][tag] = true;
            existing.push(tag);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Return count of registered blinded trait search tags for a dataset.
     * @param dataId Dataset identifier.
     * @return count Tag count.
     */
    function datasetBlindTagCount(uint256 dataId) external view returns (uint256 count) {
        return _datasetBlindTagLists[dataId].list.length;
    }

    /**
     * @notice ABI-compatible blind tag query enforcing bounds and Active lifecycle symmetry.
     * @param dataId Dataset identifier.
     * @param tagHash Blinded keccak-256 trait tag hash.
     * @return matched True if dataset is Active and contains `tagHash`.
     */
    function datasetBlindTags(uint256 dataId, bytes32 tagHash) public view returns (bool matched) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        if (uint8(_items[dataId].status) > 0) return false;
        return _datasetBlindTags[dataId][tagHash];
    }

    /**
     * @notice Serverless blind tag lookup alias enforcing Active lifecycle symmetry.
     * @param dataId Dataset identifier.
     * @param blindTag Blinded keccak-256 trait tag hash.
     * @return matched True if dataset is Active and contains `blindTag`.
     */
    function matchesBlindTag(uint256 dataId, bytes32 blindTag) external view returns (bool matched) {
        return datasetBlindTags(dataId, blindTag);
    }

    /**
     * @notice Record a unique non-zero follow-on study reuse commitment for a dataset.
     * @param dataId Dataset identifier.
     * @param studyCommitment Non-zero study commitment hash.
     */
    function recordStudyReuseReceipt(uint256 dataId, bytes32 studyCommitment) external onlyRegistry {
        if (studyCommitment == bytes32(0)) revert InvalidStudyCommitment();
        if (studyReuseReceipts[dataId][studyCommitment]) revert StudyReuseAlreadyRecorded();
        studyReuseReceipts[dataId][studyCommitment] = true;
        unchecked {
            ++datasetReuseCount[dataId];
        }
    }

    /**
     * @notice Validate candidate ZK verifier interface compatibility, ensure no active bounties are orphaned,
     *         and store the updated GenomicZkVerifier address.
     * @param newVerifier Proposed replacement ZK verifier contract address.
     * @return oldVerifier Previously linked ZK verifier address (may be zero).
     */
    function setZkVerifier(address newVerifier) external onlyRegistry returns (address oldVerifier) {
        if (newVerifier == address(0) || newVerifier.code.length == 0) revert InvalidRecipient();
        (bool ok, bytes memory ret) = newVerifier.staticcall(
            abi.encodeWithSelector(IGenomicZkVerifier.activeBountyCount.selector)
        );
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) == type(uint256).max) revert InvalidRecipient();
        oldVerifier = zkVerifier;
        if (oldVerifier != address(0) && oldVerifier != newVerifier && oldVerifier.code.length > 0) {
            if (IGenomicZkVerifier(oldVerifier).activeBountyCount() > 0) revert ActiveBountiesExist();
        }
        zkVerifier = newVerifier;
    }

    /**
     * @notice Evaluate whether a registered active dataset's creator/owner has proven a specific trait + variant commitment.
     * @param dataId Target genomic dataset identifier.
     * @param traitId Identifier of the targeted genetic trait.
     * @param variantCommitment Cryptographic commitment to the private genomic variant.
     * @return verified True if verified in the active ZK verifier epoch.
     */
    function verifyDatasetTraitPossession(
        uint256 dataId,
        bytes32 traitId,
        bytes32 variantCommitment
    ) external view returns (bool verified) {
        return _verifyZkBridge(dataId, traitId, variantCommitment, 0);
    }

    /**
     * @notice Evaluate whether a registered active dataset's creator/owner has proven a genomic variant commitment.
     * @param dataId Target genomic dataset identifier.
     * @param variantCommitment Cryptographic commitment to the private genomic variant.
     * @return verified True if verified in the active ZK verifier epoch.
     */
    function verifyDatasetTraitPossession(
        uint256 dataId,
        bytes32 variantCommitment
    ) external view returns (bool verified) {
        return _verifyZkBridge(dataId, variantCommitment, bytes32(0), 1);
    }

    /**
     * @notice Evaluate whether a registered active dataset's creator/owner has proven a dataset-bound lab-attested trait.
     * @param dataId Target genomic dataset identifier.
     * @param traitId Identifier of the targeted genetic trait.
     * @return verified True if verified in the active ZK verifier epoch.
     */
    function verifyDatasetBoundTrait(uint256 dataId, bytes32 traitId) external view returns (bool verified) {
        return _verifyZkBridge(dataId, bytes32(0), traitId, 2);
    }

    /**
     * @notice Check whether a donor has claimed a specific ZK genotype bounty on the linked verifier.
     * @param bountyId Target ZK bounty identifier.
     * @param donor Target donor address.
     * @return claimed True if the donor claimed the bounty.
     */
    function hasDonorClaimedZkBounty(uint256 bountyId, address donor) external view returns (bool claimed) {
        return zkVerifier != address(0) && IGenomicZkVerifier(zkVerifier).hasClaimedBounty(bountyId, donor);
    }

    function _verifyZkBridge(
        uint256 dataId,
        bytes32 argA,
        bytes32 argB,
        uint8 mode
    ) internal view returns (bool verified) {
        if (dataId == 0 || dataId > itemCount) revert DataNotFound();
        address zk = zkVerifier;
        GenomicsRegistryStorage.GenomicDataCore storage d = _items[dataId];
        if (zk == address(0) || d.status != GenomicsRegistryStorage.DataStatus.Active) return false;
        (bool ok, bytes memory ret) = address(GENOMIC_NFT).staticcall(abi.encodeWithSelector(0x6352211e, d.tokenId));
        address nftOwner = (ok && ret.length == 32) ? abi.decode(ret, (address)) : d.currentOwner;
        if (nftOwner == address(0) || nftOwner != GENOMIC_NFT.originalCreatorOf(d.tokenId)) return false;
        if (mode == 0) return IGenomicZkVerifier(zk).hasVerifiedTraitVariant(argA, argB, nftOwner);
        if (mode == 1) return IGenomicZkVerifier(zk).hasVerifiedVariant(argA, nftOwner);
        return IGenomicZkVerifier(zk).hasVerifiedDatasetTrait(d.rawDataHash, argB, nftOwner);
    }
}