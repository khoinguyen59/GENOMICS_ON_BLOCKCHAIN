// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGenomicZkVerifier
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Read-only verification bridge interface queried by GenomicsMetadataStore and
 *         GenomicsRegistry to verify zero-knowledge trait proofs and active bounty counts.
 */
interface IGenomicZkVerifier {
    /**
     * @notice Return the current number of active non-expired ZK bounties.
     * @return count Active bounty count.
     */
    function activeBountyCount() external view returns (uint256 count);

    /**
     * @notice Check whether `donor` has already claimed `bountyId`.
     * @param bountyId Target ZK bounty identifier.
     * @param donor Donor wallet address.
     * @return claimed True if `donor` claimed `bountyId`.
     */
    function hasClaimedBounty(uint256 bountyId, address donor) external view returns (bool claimed);

    /**
     * @notice Check whether `donor` holds a verified variant commitment in the active VK epoch.
     * @param variantCommitment BN254 MiMC-7 variant commitment hash.
     * @param donor Donor wallet address.
     * @return verified True if `donor` has verified `variantCommitment`.
     */
    function hasVerifiedVariant(bytes32 variantCommitment, address donor) external view returns (bool verified);

    /**
     * @notice Check whether `donor` holds a verified trait-bound variant commitment in the active VK epoch.
     * @param targetTraitId Target genetic trait identifier.
     * @param variantCommitment BN254 MiMC-7 variant commitment hash.
     * @param donor Donor wallet address.
     * @return verified True if `donor` has verified (`targetTraitId`, `variantCommitment`).
     */
    function hasVerifiedTraitVariant(
        bytes32 targetTraitId,
        bytes32 variantCommitment,
        address donor
    ) external view returns (bool verified);

    /**
     * @notice Check whether `donor` holds a dataset-bound lab-attested trait verification in the active VK epoch.
     * @param rawDataHash Anchored SHA-256 hash of the dataset's encrypted raw package.
     * @param traitId Target genetic trait identifier.
     * @param donor Donor wallet address.
     * @return verified True if `donor` has verified (`rawDataHash`, `traitId`).
     */
    function hasVerifiedDatasetTrait(
        bytes32 rawDataHash,
        bytes32 traitId,
        address donor
    ) external view returns (bool verified);
}
