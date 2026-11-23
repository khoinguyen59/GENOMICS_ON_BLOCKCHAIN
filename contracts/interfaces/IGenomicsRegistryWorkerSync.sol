// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGenomicsRegistryWorkerSync
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Minimal synchronization interface invoked by GenomicNFT upon ERC-721 transfer to
 *         atomically advance the O(1) delegated capsule worker authorization epoch for a token.
 */
interface IGenomicsRegistryWorkerSync {
    /**
     * @notice Reset all delegated capsule workers authorized for the dataset linked to `tokenId`.
     * @param tokenId Transferred GenomicNFT token identifier.
     */
    function resetAuthorizedWorkersForToken(uint256 tokenId) external;
}
