// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IGenomicsRegistryWorkerSync } from "../interfaces/IGenomicsRegistryWorkerSync.sol";
import { IGenomicsMetadataErrors } from "../interfaces/IGenomicsMetadataErrors.sol";

/**
 * @title GenomicsRegistryStorage
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Abstract storage layout, core domain structs, events, and EIP-1153 transient reentrancy
 *         guard inherited by GenomicsRegistry.
 * @dev Keeps per-contract state variable declarations strictly bounded while preserving full
 *      ABI compatibility and optimal storage slot packing on EscrowDeposit.
 */
abstract contract GenomicsRegistryStorage is Ownable2Step, IGenomicsRegistryWorkerSync, IGenomicsMetadataErrors {
    /// @notice Lifecycle states of a registered genomic dataset.
    enum DataStatus {
        Active,
        Paused,
        Revoked
    }

    /// @notice Compact on-chain core record (zero duplicate CID strings; CIDs live canonically in GenomicNFT.records).
    struct GenomicDataCore {
        uint256 tokenId;
        address currentOwner;
        DataStatus status;
        bytes32 rawDataHash;
        uint256 price;
        uint256 accessDuration;
        uint256 accessCount;
        uint256 registeredAt;
    }

    /// @notice Core on-chain descriptor for an encrypted genomic dataset NFT (ABI-compatible view struct).
    struct GenomicData {
        uint256 dataId;
        uint256 tokenId;
        address currentOwner;
        bytes32 rawDataHash;
        string rawCiphertextCid;
        string summaryCiphertextCid;
        string metadataCid;
        uint256 price;
        uint256 accessDuration;
        DataStatus status;
        uint256 accessCount;
        uint256 registeredAt;
    }

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

    /// @notice Maximum number of blinded trait search tags per dataset.
    uint256 public constant MAX_BLIND_TAGS_PER_DATASET = 16;
    /// @notice Follow-on study reuse fee rate in basis points (500 = 5%).
    uint256 public constant REUSE_FEE_BPS = 500;
    /// @notice Maximum permitted license duration per purchase (365 days).
    uint256 public constant MAX_ACCESS_DURATION = 365 days;
    /// @notice Maximum buyer-requested manual escrow confirmation hold extension (7 days).
    uint256 public constant MAX_MANUAL_ESCROW_EXTENSION = 7 days;
    /// @notice Maximum arbitration timeout before buyer may claim a unilateral dispute refund (30 days).
    uint256 public constant DISPUTE_ARBITRATION_TIMEOUT = 30 days;
    /// @notice Maximum permitted dataset license price (100M $GENO, matching GenomicToken.MAX_TOTAL_SUPPLY).
    uint256 public constant MAX_PRICE = 100_000_000 ether;

    /// @notice Total number of registered genomic datasets.
    uint256 public dataCount;

    /// @notice Raw ciphertext SHA-256 hash => true once registered (anti-clone guard).
    mapping(bytes32 => bool) public registeredRawDataHashes;

    /// @notice Global authorized proxy re-encryption capsule dispatcher address.
    address public capsuleDispatcher;

    /// @notice Dataset ID => true if the dataset owner opted out of global capsuleDispatcher authority.
    mapping(uint256 => bool) public dispatcherDisabled;

    /// @notice ERC-721 tokenId to registry dataId reverse index.
    mapping(uint256 => uint256) public tokenToDataId;

    /**
     * @notice Emitted when mistakenly sent non-payment ERC-20 tokens are rescued by governance.
     * @param token Rescued ERC-20 token address.
     * @param to Recipient address.
     * @param amount Amount rescued in token wei.
     */
    event TokensRescued(address indexed token, address indexed to, uint256 indexed amount);

    /**
     * @notice Emitted when a researcher registers or rotates their asymmetric RSA-OAEP public key.
     * @param researcher Researcher wallet address.
     * @param publicKey Serialized JWK or SPKI public key string.
     */
    event ResearcherKeyRegistered(address indexed researcher, string publicKey);

    /**
     * @notice Emitted when governance updates the global authorized capsule dispatcher.
     * @param oldDispatcher Previous dispatcher address.
     * @param newDispatcher New dispatcher address.
     */
    event CapsuleDispatcherUpdated(address indexed oldDispatcher, address indexed newDispatcher);

    /**
     * @notice Emitted when a dataset owner toggles opt-out from the global capsule dispatcher.
     * @param dataId Dataset identifier.
     * @param disabled True if the global dispatcher is disabled for `dataId`.
     */
    event DispatcherOptOutUpdated(uint256 indexed dataId, bool indexed disabled);

    /**
     * @notice Emitted when governance updates the linked GenomicZkVerifier contract.
     * @param oldVerifier Previous verifier address.
     * @param newVerifier New verifier address.
     */
    event ZkVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    /**
     * @notice Emitted when a dataset owner authorizes or revokes a delegated capsule worker.
     * @param dataId Dataset identifier.
     * @param worker Delegated worker address.
     * @param authorized True if authorized, false if revoked.
     */
    event CapsuleWorkerAuthorized(uint256 indexed dataId, address indexed worker, bool indexed authorized);

    /**
     * @notice Emitted when a new encrypted genomic dataset and its ownership NFT are registered.
     * @param dataId Assigned dataset identifier.
     * @param tokenId Minted ERC-721 token identifier.
     * @param owner Original donor/creator address.
     * @param rawDataHash SHA-256 hash of encrypted raw package.
     * @param price License price in $GENO wei.
     * @param metadataCid Public IPFS CID of GA4GH Phenopacket v2 JSON.
     */
    event GenomicDataRegistered(
        uint256 indexed dataId,
        uint256 indexed tokenId,
        address indexed owner,
        bytes32 rawDataHash,
        uint256 price,
        string metadataCid
    );

    /**
     * @notice Emitted when a researcher completes a direct license purchase.
     * @param dataId Purchased dataset identifier.
     * @param researcher Purchasing researcher address.
     * @param paidAmount Total payment in $GENO wei.
     * @param royaltyAmount EIP-2981 royalty portion in $GENO wei.
     * @param expiresAt License expiration timestamp.
     */
    event AccessGranted(
        uint256 indexed dataId,
        address indexed researcher,
        uint256 paidAmount,
        uint256 royaltyAmount,
        uint256 indexed expiresAt
    );

    /**
     * @notice Emitted when a dataset owner updates the license price.
     * @param dataId Dataset identifier.
     * @param oldPrice Previous price in $GENO wei.
     * @param newPrice New price in $GENO wei.
     */
    event DataPriceUpdated(uint256 indexed dataId, uint256 indexed oldPrice, uint256 indexed newPrice);

    /**
     * @notice Emitted when a dataset owner grants complimentary direct access.
     * @param dataId Dataset identifier.
     * @param recipient Granted researcher address.
     * @param expiresAt License expiration timestamp.
     */
    event DirectAccessGranted(uint256 indexed dataId, address indexed recipient, uint256 indexed expiresAt);

    /**
     * @notice Emitted when a dataset transitions lifecycle status.
     * @param dataId Dataset identifier.
     * @param oldStatus Prior DataStatus value.
     * @param newStatus Updated DataStatus value.
     */
    event DataStatusUpdated(uint256 indexed dataId, DataStatus oldStatus, DataStatus newStatus);

    /**
     * @notice Emitted when a key capsule is persisted and broadcasted in event logs.
     * @param dataId Dataset identifier.
     * @param researcher Recipient researcher address.
     * @param capsule Serialized RSA-OAEP JSON key capsule.
     */
    event CapsuleStored(uint256 indexed dataId, address indexed researcher, string capsule);

    /**
     * @notice Emitted upon every capsule delivery with its keccak-256 integrity digest.
     * @param dataId Dataset identifier.
     * @param researcher Recipient researcher address.
     * @param capsuleHash Keccak-256 hash of the delivered capsule string.
     */
    event CapsuleDelivered(uint256 indexed dataId, address indexed researcher, bytes32 indexed capsuleHash);

    /**
     * @notice Emitted whenever an EIP-2981 royalty payment is settled.
     * @param dataId Dataset identifier.
     * @param creator Royalty recipient (original creator) address.
     * @param amount Royalty amount in $GENO wei.
     */
    event RoyaltyPaid(uint256 indexed dataId, address indexed creator, uint256 indexed amount);

    /**
     * @notice Emitted when a buyer opens a timelocked escrow purchase.
     * @param dataId Dataset identifier.
     * @param buyer Buyer address.
     * @param amount Escrowed $GENO amount in wei.
     * @param disputeWindow Initial seller delivery / buyer dispute window in seconds.
     */
    event EscrowDeposited(
        uint256 indexed dataId,
        address indexed buyer,
        uint256 indexed amount,
        uint256 disputeWindow
    );

    /**
     * @notice Emitted when escrowed funds are settled to seller and EIP-2981 royalty recipient.
     * @param dataId Dataset identifier.
     * @param buyer Buyer address.
     * @param seller Seller address receiving net proceeds.
     * @param sellerProceeds Net seller proceeds in $GENO wei.
     * @param royaltyAmount EIP-2981 royalty settled in $GENO wei.
     */
    event EscrowReleased(
        uint256 indexed dataId,
        address indexed buyer,
        address indexed seller,
        uint256 sellerProceeds,
        uint256 royaltyAmount
    );

    /**
     * @notice Emitted when escrowed funds are refunded 100% to the buyer.
     * @param dataId Dataset identifier.
     * @param buyer Buyer address.
     * @param amount Refunded amount in $GENO wei.
     */
    event EscrowRefunded(uint256 indexed dataId, address indexed buyer, uint256 indexed amount);

    /**
     * @notice Emitted when a buyer freezes a delivered escrow for governance arbitration.
     * @param dataId Dataset identifier.
     * @param buyer Disputing buyer address.
     */
    event EscrowDisputed(uint256 indexed dataId, address indexed buyer);

    /**
     * @notice Emitted when governance resolves a disputed escrow.
     * @param dataId Dataset identifier.
     * @param buyer Disputing buyer address.
     * @param refundBuyer True if funds were refunded to buyer, false if released to seller.
     * @param amount Settled $GENO amount in wei.
     */
    event EscrowDisputeResolved(
        uint256 indexed dataId,
        address indexed buyer,
        bool indexed refundBuyer,
        uint256 amount
    );

    /**
     * @notice Emitted when a buyer explicitly confirms capsule receipt and releases escrow early.
     * @param dataId Dataset identifier.
     * @param buyer Confirming buyer address.
     */
    event EscrowConfirmed(uint256 indexed dataId, address indexed buyer);

    /**
     * @notice Emitted when a donor submits a salted anti-front-running registration commitment.
     * @param commitment Salted keccak-256 registration commitment.
     * @param donor Donor wallet address.
     * @param blockNumber Block number at which commitment was recorded.
     */
    event GenomicDataCommitted(bytes32 indexed commitment, address indexed donor, uint256 indexed blockNumber);

    /**
     * @notice Emitted when governance toggles strict commit-reveal registration mode.
     * @param required True if commit-reveal is now mandatory.
     */
    event CommitRevealRequirementUpdated(bool indexed required);

    /**
     * @notice Emitted when encrypted summary PDF and Phenopacket metadata hashes are anchored on-chain.
     * @param dataId Dataset identifier.
     * @param summaryHash SHA-256 hash of encrypted clinical summary PDF.
     * @param metadataHash SHA-256 hash of public GA4GH Phenopacket JSON.
     */
    event ArtifactHashesAnchored(uint256 indexed dataId, bytes32 summaryHash, bytes32 metadataHash);

    /**
     * @notice Emitted for each blinded trait tag indexed on a dataset.
     * @param dataId Dataset identifier.
     * @param blindTag Salted domain-separated keccak-256 trait tag.
     */
    event BlindTagRegistered(uint256 indexed dataId, bytes32 indexed blindTag);

    /**
     * @notice Emitted when a follow-on study reuse fee (5% + EIP-2981 split) is settled.
     * @param dataId Dataset identifier.
     * @param researcher Researcher recording study reuse.
     * @param studyCommitment Unique per-dataset commitment hash for the follow-on study.
     * @param totalFee Total 5% reuse fee paid in $GENO wei.
     * @param royaltyPaid EIP-2981 royalty disbursed in $GENO wei.
     */
    event StudyReuseRecorded(
        uint256 indexed dataId,
        address indexed researcher,
        bytes32 indexed studyCommitment,
        uint256 totalFee,
        uint256 royaltyPaid
    );
}