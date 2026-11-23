// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGenomicsMetadataErrors
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Shared custom error catalog inherited by GenomicsRegistryStorage, GenomicsMetadataStore,
 *         and GenomicsEscrowEngine to preserve unified ABI error selectors without redeclaration.
 */
interface IGenomicsMetadataErrors {
    /// @notice Thrown when attempting to rotate the ZK verifier while active bounties exist.
    error ActiveBountiesExist();
    /// @notice Thrown when summary and metadata artifact hashes are already anchored for a dataset.
    error ArtifactHashesAlreadyAnchored();
    /// @notice Thrown when an identical salted commit-reveal commitment has already been recorded.
    error CommitmentAlreadyExists();
    /// @notice Thrown when a required commit-reveal commitment has not been submitted.
    error CommitmentNotFound();
    /// @notice Thrown when a commit-reveal registration is revealed in the same block as its commit.
    error CommitmentTooNew();
    /// @notice Thrown when a researcher submits an empty public key string.
    error EmptyPublicKey();
    /// @notice Thrown when a blind tag array exceeds limits, contains zero, or has duplicates.
    error InvalidBlindTag();
    /// @notice Thrown when a serialized public key or RSA-OAEP capsule fails length or JSON format validation.
    error InvalidCapsuleFormat();
    /// @notice Thrown when a zero commit-reveal commitment is submitted.
    error InvalidCommitment();
    /// @notice Thrown when accessDuration is zero or exceeds MAX_ACCESS_DURATION.
    error InvalidDuration();
    /// @notice Thrown when dataset price is zero or exceeds MAX_PRICE.
    error InvalidPrice();
    /// @notice Thrown when a follow-on study reuse commitment is zero.
    error InvalidStudyCommitment();
    /// @notice Thrown when a follow-on study reuse commitment has already been recorded for a dataset.
    error StudyReuseAlreadyRecorded();
    /// @notice Thrown when a buyer already holds an active unexpired access grant for a dataset.
    error AccessAlreadyActive();
    /// @notice Thrown when a previously granted dataset license has expired.
    error AccessExpired();
    /// @notice Thrown when a caller does not hold a valid delivered dataset access grant.
    error AccessNotGranted();
    /// @notice Thrown when an operation conflicts with an already-delivered or already-released capsule.
    error CapsuleAlreadyDelivered();
    /// @notice Thrown when escrow release or dispute requires prior capsule delivery.
    error CapsuleNotDelivered();
    /// @notice Thrown when a buyer claims an arbitration timeout refund before DISPUTE_ARBITRATION_TIMEOUT elapses.
    error DisputeArbitrationActive();
    /// @notice Thrown when seller release or timeout refund is attempted while the dispute window is still active.
    error DisputeWindowActive();
    /// @notice Thrown when a buyer files a dispute or requests manual hold after the dispute window expired.
    error DisputeWindowExpired();
    /// @notice Thrown when an empty key capsule string is submitted.
    error EmptyCapsule();
    /// @notice Thrown when an unsettled escrow deposit already exists for a dataset and buyer.
    error EscrowAlreadyActive();
    /// @notice Thrown when an action is blocked because the escrow is frozen in dispute arbitration.
    error EscrowDisputedError();
    /// @notice Thrown when no active unsettled escrow deposit exists for the dataset and buyer.
    error EscrowNotActive();
    /// @notice Thrown when dispute resolution or timeout claim is invoked on an undisputed escrow.
    error EscrowNotDisputed();
    /// @notice Thrown when an escrow dispute window is shorter than 1 hour or longer than 30 days.
    error InvalidDisputeWindow();
}
