// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GenomicNFT (GNFT)
 * @author GenomicsBlockchainAgent
 * @notice ERC-721 Data Ownership NFT with full EIP-2981 Royalty Enforcement.
 * @dev Enforces strict minting access: ONLY the authorized GenomicsRegistry can mint NFTs.
 *      Each NFT uniquely represents an encrypted genomic dataset uploaded by a patient/data owner.
 */
contract GenomicNFT is ERC721URIStorage, ERC2981, Ownable {
    uint256 private _nextTokenId;
    address public registryContract;

    struct GenomicRecord {
        address originalCreator;
        bytes32 rawDataHash;         // SHA-256 integrity hash of the raw dataset
        string rawCiphertextCid;     // IPFS CID of encrypted raw sequence (.vcf/.fastq)
        string summaryCiphertextCid; // IPFS CID of encrypted summary report (.pdf)
        string metadataCid;          // IPFS CID of public GA4GH phenotype metadata (.json)
        uint256 createdAt;
    }

    mapping(uint256 => GenomicRecord) public records;

    event GenomicNFTMinted(
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 rawDataHash,
        string rawCiphertextCid,
        string summaryCiphertextCid,
        string metadataCid,
        uint96 royaltyFeeBps
    );
    event RegistryContractUpdated(address indexed newRegistry);

    error OnlyRegistry();
    error InvalidAddress();

    modifier onlyRegistry() {
        if (msg.sender != registryContract) {
            revert OnlyRegistry();
        }
        _;
    }

    constructor(
        address initialOwner,
        uint96 defaultRoyaltyBps
    ) ERC721("Genomic Data Ownership NFT", "GNFT") Ownable(initialOwner) {
        // Set default royalty fee (e.g. 1000 = 10%)
        _setDefaultRoyalty(initialOwner, defaultRoyaltyBps);
    }

    /**
     * @notice Set or update the authorized GenomicsRegistry contract address
     * @param registryAddress Address of the GenomicsRegistry contract
     */
    function setRegistryContract(address registryAddress) external onlyOwner {
        if (registryAddress == address(0)) revert InvalidAddress();
        registryContract = registryAddress;
        emit RegistryContractUpdated(registryAddress);
    }

    /**
     * @notice Mint a new Genomic NFT for an uploaded dataset.
     *         STRICT ACCESS CONTROL: Can ONLY be called by the verified GenomicsRegistry contract.
     * @param to Owner receiving the newly minted NFT
     * @param uri IPFS tokenURI pointing to metadata
     * @param rawDataHash SHA-256 integrity hash of the raw dataset
     * @param rawCid IPFS CID of encrypted raw VCF/FASTQ
     * @param summaryCid IPFS CID of encrypted summary PDF
     * @param metadataCid IPFS CID of GA4GH Phenopacket JSON
     * @param royaltyBps Basis points for royalty (e.g., 1000 = 10%)
     * @return tokenId Newly created NFT tokenId
     */
    function mintGenomicNFT(
        address to,
        string memory uri,
        bytes32 rawDataHash,
        string memory rawCid,
        string memory summaryCid,
        string memory metadataCid,
        uint96 royaltyBps
    ) external onlyRegistry returns (uint256) {
        uint256 tokenId = ++_nextTokenId;

        // CHECKS-EFFECTS-INTERACTIONS: Set internal state and royalties before triggering external callbacks
        _setTokenURI(tokenId, uri);
        _setTokenRoyalty(tokenId, to, royaltyBps);

        records[tokenId] = GenomicRecord({
            originalCreator: to,
            rawDataHash: rawDataHash,
            rawCiphertextCid: rawCid,
            summaryCiphertextCid: summaryCid,
            metadataCid: metadataCid,
            createdAt: block.timestamp
        });

        emit GenomicNFTMinted(tokenId, to, rawDataHash, rawCid, summaryCid, metadataCid, royaltyBps);

        // Interaction: Call _safeMint after all effects are persisted
        _safeMint(to, tokenId);

        return tokenId;
    }

    /**
     * @notice Returns the next token ID to be minted
     */
    function nextTokenId() external view returns (uint256) {
        return _nextTokenId + 1;
    }

    /**
     * @notice Retrieve genomic record details for a given token
     */
    function getGenomicRecord(uint256 tokenId) external view returns (GenomicRecord memory) {
        _requireOwned(tokenId);
        return records[tokenId];
    }

    /**
     * @dev Hook invoked upon token transfer (mint/burn/transfer).
     *      When ownership changes, notifies GenomicsRegistry to reset authorized capsule workers (DEF2-1-05).
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override
        returns (address)
    {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to) {
            if (registryContract != address(0)) {
                (bool success, ) = registryContract.call(
                    abi.encodeWithSignature("resetAuthorizedWorkersForToken(uint256)", tokenId)
                );
                if (!success) {
                    (bool fallbackSuccess, ) = registryContract.call(
                        abi.encodeWithSignature("resetAuthorizedWorkers(uint256)", tokenId)
                    );
                    (fallbackSuccess); // silence compiler warning
                }
            }
        }
        return from;
    }

    /**
     * @dev Override supportsInterface for ERC721URIStorage and ERC2981
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC2981)
        returns (bool)
    {
        return ERC721URIStorage.supportsInterface(interfaceId) || ERC2981.supportsInterface(interfaceId);
    }
}
