// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { GenomicsRegistry } from "../GenomicsRegistry.sol";

/**
 * @title MaliciousReentrantReceiver
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Simulates an adversarial smart contract that attempts to exploit reentrancy
 *         via the ERC721 onERC721Received hook during registration.
 *         Based on Trail of Bits 'building-secure-contracts' attack vectors.
 */
contract MaliciousReentrantReceiver is IERC721Receiver {
    /// @notice Target GenomicsRegistry contract under reentrancy test.
    GenomicsRegistry public registry;
    /// @notice True once a reentrancy attempt has been initiated.
    bool public attackInitiated;
    /// @notice True if the nested reentrant call unexpectedly succeeded.
    bool public attackSucceeded;
    /// @notice Captured revert message from the blocked reentrant call.
    string public lastErrorMessage;

    string private constant _ATTACK_PREFIX_1 = "QmMalicious11111111111";
    string private constant _ATTACK_PREFIX_2 = "QmMalicious22222222222";
    string private constant _ATTACK_PREFIX_3 = "QmMalicious33333333333";
    string private constant _ATTACK_SUFFIX_1 = "111111111111111111111";
    string private constant _ATTACK_SUFFIX_2 = "222222222222222222222";
    string private constant _ATTACK_SUFFIX_3 = "333333333333333333333";

    /**
     * @notice Deploy receiver bound to target GenomicsRegistry.
     * @param _registry Target GenomicsRegistry address.
     */
    constructor(address _registry) {
        registry = GenomicsRegistry(_registry);
    }

    /**
     * @notice Invoke GenomicsRegistry.registerGenomicData from this adversarial contract.
     * @param rawDataHash Anchored SHA-256 hash of encrypted raw package.
     * @param rawCid Encrypted raw sequence IPFS CID.
     * @param summaryCid Encrypted clinical summary IPFS CID.
     * @param metadataCid Public Phenopacket IPFS CID.
     * @param tokenUri ERC-721 token URI.
     * @param price License price in $GENO wei.
     * @param accessDuration License duration in seconds.
     * @param royaltyBps EIP-2981 royalty rate in basis points.
     */
    function registerWithRegistry(
        bytes32 rawDataHash,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        string calldata tokenUri,
        uint256 price,
        uint256 accessDuration,
        uint96 royaltyBps
    ) external {
        registry.registerGenomicData(
            rawDataHash,
            rawCid,
            summaryCid,
            metadataCid,
            tokenUri,
            price,
            accessDuration,
            royaltyBps
        );
    }

    /**
     * @notice ERC-721 receipt hook attempting to re-enter GenomicsRegistry.registerGenomicData.
     * @return selector Standard IERC721Receiver.onERC721Received selector.
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4 selector) {
        if (!attackInitiated) {
            attackInitiated = true;
            try registry.registerGenomicData(
                keccak256("malicious_data"),
                string.concat(_ATTACK_PREFIX_1, _ATTACK_SUFFIX_1),
                string.concat(_ATTACK_PREFIX_2, _ATTACK_SUFFIX_2),
                string.concat(_ATTACK_PREFIX_3, _ATTACK_SUFFIX_3),
                "ipfs://malicious-uri",
                10 ether,
                86400,
                500
            ) {
                attackSucceeded = true;
            } catch Error(string memory reason) {
                lastErrorMessage = reason;
            } catch (bytes memory) {
                lastErrorMessage = "ReentrancyGuardReentrantCall()";
            }
        }
        return this.onERC721Received.selector;
    }
}
