// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../GenomicsRegistry.sol";

/**
 * @title MaliciousReentrantReceiver
 * @notice Simulates an adversarial smart contract that attempts to exploit reentrancy
 *         via the ERC721 onERC721Received hook during registration.
 *         Based on Trail of Bits 'building-secure-contracts' attack vectors.
 */
contract MaliciousReentrantReceiver is IERC721Receiver {
    GenomicsRegistry public registry;
    bool public attackInitiated;
    bool public attackSucceeded;
    string public lastErrorMessage;

    constructor(address _registry) {
        registry = GenomicsRegistry(_registry);
    }

    function registerWithRegistry(
        bytes32 rawDataHash,
        string memory rawCid,
        string memory summaryCid,
        string memory metadataCid,
        string memory tokenUri,
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

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (!attackInitiated) {
            attackInitiated = true;
            // Attempt to re-enter registry.registerGenomicData
            try registry.registerGenomicData(
                keccak256("malicious_data"),
                "QmMalicious11111111111111111111111111111111",
                "QmMalicious22222222222222222222222222222222",
                "QmMalicious33333333333333333333333333333333",
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
