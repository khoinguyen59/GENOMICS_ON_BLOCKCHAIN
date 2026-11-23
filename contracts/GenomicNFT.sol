// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC721URIStorage } from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IGenomicsRegistryWorkerSync } from "./interfaces/IGenomicsRegistryWorkerSync.sol";

/**
 * @title GenomicNFT (GNFT)
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice ERC-721 Data Ownership NFT with full EIP-2981 Royalty Enforcement.
 * @dev Enforces strict minting access: ONLY the authorized GenomicsRegistry can mint NFTs.
 *      Each NFT uniquely represents an encrypted genomic dataset uploaded by a patient/data owner.
 *      Also provides gas-optimized pure IPFS Multihash CIDv0/CIDv1 validation, XSS-safe tokenURI
 *      validation, and RFC 8259 JSON key capsule validation with fast-path hex/string scanning.
 */
contract GenomicNFT is ERC721URIStorage, ERC2981, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum permitted EIP-2981 royalty ceiling (5000 bps = 50%).
    uint96 public constant MAX_ROYALTY_BPS = 5000;
    /// @notice Maximum permitted tokenURI byte length to prevent unbounded storage griefing.
    uint256 public constant MAX_TOKEN_URI_LENGTH = 2048;
    uint256 private _nextTokenId;
    /// @notice Authorized GenomicsRegistry contract permitted to mint genomic dataset NFTs.
    address public registryContract;

    /// @notice Immutable on-chain genomic dataset provenance record bound to an ERC-721 tokenId.
    struct GenomicRecord {
        address originalCreator;
        bytes32 rawDataHash;
        string rawCiphertextCid;
        string summaryCiphertextCid;
        string metadataCid;
        uint256 createdAt;
    }

    /// @notice Token ID to immutable GenomicRecord metadata.
    mapping(uint256 => GenomicRecord) public records;

    /**
     * @notice Emitted when a new GenomicNFT is minted for a registered encrypted dataset.
     * @param tokenId Newly minted ERC-721 token identifier.
     * @param creator Original donor/creator receiving the NFT and EIP-2981 royalties.
     * @param rawDataHash SHA-256 hash of encrypted raw package (`IV || Ciphertext`).
     * @param rawCiphertextCid Validated IPFS CID of encrypted raw sequence file.
     * @param summaryCiphertextCid Validated IPFS CID of encrypted clinical summary PDF.
     * @param metadataCid Validated IPFS CID of public GA4GH Phenopacket v2 JSON.
     * @param royaltyFeeBps Configured EIP-2981 royalty rate in basis points.
     */
    event GenomicNFTMinted(
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 rawDataHash,
        string rawCiphertextCid,
        string summaryCiphertextCid,
        string metadataCid,
        uint96 indexed royaltyFeeBps
    );

    /**
     * @notice Emitted when governance links or updates the authorized GenomicsRegistry contract.
     * @param newRegistry Address of the authorized GenomicsRegistry contract.
     */
    event RegistryContractUpdated(address indexed newRegistry);

    /**
     * @notice Emitted when mistakenly sent ERC-20 tokens are rescued from the NFT contract.
     * @param token Rescued ERC-20 token address.
     * @param to Recipient address.
     * @param amount Rescued token amount in wei.
     */
    event TokensRescued(address indexed token, address indexed to, uint256 indexed amount);

    /// @notice Thrown when a caller other than `registryContract` invokes `mintGenomicNFT`.
    error OnlyRegistry();
    /// @notice Thrown when a zero or non-matching contract address is supplied.
    error InvalidAddress();
    /// @notice Thrown when any IPFS CID or tokenURI fails strict cryptographic or XSS validation.
    error InvalidDataHashOrCid();

    modifier onlyRegistry() {
        if (msg.sender != registryContract) {
            revert OnlyRegistry();
        }
        _;
    }

    /**
     * @notice Deploy GenomicNFT with default EIP-2981 royalty parameters.
     * @param initialOwner Governance owner of the NFT contract.
     * @param defaultRoyaltyBps Default EIP-2981 royalty basis points (capped at MAX_ROYALTY_BPS).
     */
    constructor(
        address initialOwner,
        uint96 defaultRoyaltyBps
    ) ERC721("Genomic Data Ownership NFT", "GNFT") Ownable(initialOwner) {
        if (defaultRoyaltyBps > MAX_ROYALTY_BPS) {
            revert ERC2981InvalidDefaultRoyalty(defaultRoyaltyBps, MAX_ROYALTY_BPS);
        }
        _setDefaultRoyalty(initialOwner, defaultRoyaltyBps);
    }

    /**
     * @notice Set or update the authorized GenomicsRegistry contract address.
     * @param registryAddress Address of the GenomicsRegistry contract.
     */
    function setRegistryContract(address registryAddress) external onlyOwner {
        if (registryAddress == address(0) || registryAddress.code.length == 0) revert InvalidAddress();
        (bool ok, bytes memory ret) = registryAddress.staticcall(
            abi.encodeWithSelector(bytes4(keccak256("genomicNFT()")))
        );
        if (!ok || ret.length != 32 || abi.decode(ret, (address)) != address(this)) revert InvalidAddress();
        registryContract = registryAddress;
        emit RegistryContractUpdated(registryAddress);
    }

    /**
     * @notice Return the three anchored IPFS CIDs and live ERC-721 owner for a minted genomic token in one call.
     * @param tokenId GenomicNFT token identifier.
     * @return rawCid IPFS CID of encrypted raw genomic package.
     * @return summaryCid IPFS CID of encrypted clinical summary PDF.
     * @return metaCid IPFS CID of public GA4GH Phenopacket v2 JSON.
     * @return currentOwner Live ERC-721 token owner (or address(0) if unminted/burned).
     */
    function recordCidsAndOwner(uint256 tokenId)
        external
        view
        returns (string memory rawCid, string memory summaryCid, string memory metaCid, address currentOwner)
    {
        GenomicRecord storage rec = records[tokenId];
        return (rec.rawCiphertextCid, rec.summaryCiphertextCid, rec.metadataCid, _ownerOf(tokenId));
    }

    /**
     * @notice Rescue mistakenly sent ERC-20 tokens to the NFT contract.
     * @param tokenAddress The ERC-20 token address to rescue.
     * @param to The recipient address.
     * @param amount The token amount in wei.
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner nonReentrant {
        if (tokenAddress == address(0) || to == address(0)) revert InvalidAddress();
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokensRescued(tokenAddress, to, amount);
    }

    /**
     * @notice Mint a new Genomic NFT for an uploaded dataset.
     *         STRICT ACCESS CONTROL: Can ONLY be called by the verified GenomicsRegistry contract.
     * @param to Owner receiving the newly minted NFT.
     * @param uri IPFS or HTTPS tokenURI pointing to metadata (XSS schemes and control chars blocked).
     * @param rawDataHash SHA-256 integrity hash of the encrypted raw dataset.
     * @param rawCid IPFS CID of encrypted raw VCF/FASTQ.
     * @param summaryCid IPFS CID of encrypted summary PDF.
     * @param metadataCid IPFS CID of GA4GH Phenopacket JSON.
     * @param royaltyBps Basis points for royalty (e.g., 1000 = 10%).
     * @return tokenId Newly created NFT tokenId.
     */
    function mintGenomicNFT(
        address to,
        string calldata uri,
        bytes32 rawDataHash,
        string calldata rawCid,
        string calldata summaryCid,
        string calldata metadataCid,
        uint96 royaltyBps
    ) external onlyRegistry returns (uint256 tokenId) {
        if (
            !_validateTokenUri(uri) ||
            !_validateCid(rawCid) ||
            !_validateCid(summaryCid) ||
            !_validateCid(metadataCid)
        ) {
            revert InvalidDataHashOrCid();
        }
        tokenId = ++_nextTokenId;
        if (royaltyBps > MAX_ROYALTY_BPS) {
            revert ERC2981InvalidTokenRoyalty(tokenId, royaltyBps, MAX_ROYALTY_BPS);
        }

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
        _safeMint(to, tokenId);
    }

    /**
     * @notice Returns the next token ID to be minted.
     * @return nextId Sequential token ID that will be assigned to the next minted NFT.
     */
    function nextTokenId() external view returns (uint256 nextId) {
        return _nextTokenId + 1;
    }

    /**
     * @notice Retrieve genomic record details for a given token.
     * @param tokenId Existing ERC-721 token identifier.
     * @return record Stored GenomicRecord struct.
     */
    function getGenomicRecord(uint256 tokenId) external view returns (GenomicRecord memory record) {
        _requireOwned(tokenId);
        return records[tokenId];
    }

    /**
     * @notice Lightweight accessor for original dataset creator address.
     * @param tokenId Existing ERC-721 token identifier.
     * @return creator Original creator address receiving EIP-2981 royalties.
     */
    function originalCreatorOf(uint256 tokenId) external view returns (address creator) {
        _requireOwned(tokenId);
        return records[tokenId].originalCreator;
    }

    bytes internal constant CIDV0_MIN = "QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51";
    bytes internal constant CIDV0_MAX = "QmfZy5bvk7a3DQAjCbGNtmrPXWkyVvPrdnZMyBZ5q5ieKG";

    function _cmpBytes46(bytes calldata a, bytes memory b) internal pure returns (int256) {
        for (uint256 i = 0; i < 46; ) {
            bytes1 ca = a[i];
            bytes1 cb = b[i];
            if (ca < cb) return -1;
            if (ca > cb) return 1;
            unchecked {
                ++i;
            }
        }
        return 0;
    }

    function _base32Val(bytes1 c) internal pure returns (uint8) {
        if (c > 0x60 && c < 0x7b) return uint8(c) - 97;
        if (c > 0x31 && c < 0x38) return uint8(c) - 24;
        return 255;
    }

    /**
     * @notice Validate that a tokenURI is non-empty, <= MAX_TOKEN_URI_LENGTH (2048) bytes,
     *         free of ASCII control chars, and does not use executable XSS schemes
     *         (`javascript:`, `data:`, `vbscript:`).
     * @param uri Candidate tokenURI string.
     * @return valid True if safe, non-empty, and within length ceiling.
     */
    function validateTokenUri(string calldata uri) external pure returns (bool valid) {
        return _validateTokenUri(uri);
    }

    function _matchesSchemeCI(bytes calldata b, uint256 start, bytes memory scheme) internal pure returns (bool) {
        uint256 sLen = scheme.length;
        if (b.length < start + sLen) return false;
        for (uint256 i = 0; i < sLen; ) {
            bytes1 ch = b[start + i];
            if (ch > 0x40 && ch < 0x5b) ch = ch | 0x20;
            if (ch != scheme[i]) return false;
            unchecked {
                ++i;
            }
        }
        return true;
    }

    function _validateTokenUri(string calldata uri) internal pure returns (bool) {
        bytes calldata b = bytes(uri);
        uint256 len = b.length;
        if (len == 0 || len > MAX_TOKEN_URI_LENGTH) return false;
        uint256 firstNonSpace = len;
        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7f) return false;
            if (firstNonSpace == len && c != 0x20) firstNonSpace = i;
            unchecked {
                ++i;
            }
        }
        if (firstNonSpace == len) return false;
        if (
            _matchesSchemeCI(b, firstNonSpace, "javascript:") ||
            _matchesSchemeCI(b, firstNonSpace, "data:") ||
            _matchesSchemeCI(b, firstNonSpace, "vbscript:")
        ) {
            return false;
        }
        return true;
    }

    /**
     * @notice Pure RFC-compliant IPFS Multihash validator:
     *         - CIDv0: 46-char Base58btc strictly decoding to 34-byte SHA2-256 multihash (0x12 0x20 || 32B)
     *         - CIDv1: RFC 4648 lowercase Base32 ('b' multibase) with decoded header verification:
     *           version=0x01, IPLD codec in {0x70 dag-pb, 0x55 raw, 0x71 dag-cbor},
     *           strict multihash + exact length (SHA2-256 len=59, BLAKE2b-256 len=62 with 0xa0 0xe4 0x02, SHA2-512 len=110),
     *           and canonical zero trailing Base32 padding bits.
     * @param cid Candidate IPFS CID string.
     * @return valid True if `cid` is a canonical CIDv0 or supported CIDv1 multihash.
     */
    function validateCid(string calldata cid) external pure returns (bool valid) {
        return _validateCid(cid);
    }

    function _validateCid(string calldata cid) internal pure returns (bool) {
        bytes calldata b = bytes(cid);
        uint256 len = b.length;
        if (len == 46 && b[0] == "Q" && b[1] == "m") return _validateCidV0(b);
        if ((len == 59 || len == 62 || len == 110) && b[0] == "b") return _validateCidV1(b, len);
        return false;
    }

    function _validateCidV0(bytes calldata b) internal pure returns (bool) {
        for (uint256 i = 2; i < 46; ) {
            bytes1 c = b[i];
            if (
                !((c > 0x30 && c < 0x3a) ||
                    (c > 0x40 && c < 0x5b && c != "I" && c != "O") ||
                    (c > 0x60 && c < 0x7b && c != "l"))
            ) return false;
            unchecked {
                ++i;
            }
        }
        return !(_cmpBytes46(b, CIDV0_MIN) < 0) && !(_cmpBytes46(b, CIDV0_MAX) > 0);
    }

    function _validateCidV1(bytes calldata b, uint256 len) internal pure returns (bool) {
        for (uint256 i = 1; i < len; ) {
            if (_base32Val(b[i]) == 255) return false;
            unchecked {
                ++i;
            }
        }
        uint256 hdr50 = (uint256(_base32Val(b[1])) << 45) |
            (uint256(_base32Val(b[2])) << 40) |
            (uint256(_base32Val(b[3])) << 35) |
            (uint256(_base32Val(b[4])) << 30) |
            (uint256(_base32Val(b[5])) << 25) |
            (uint256(_base32Val(b[6])) << 20) |
            (uint256(_base32Val(b[7])) << 15) |
            (uint256(_base32Val(b[8])) << 10) |
            (uint256(_base32Val(b[9])) << 5) |
            uint256(_base32Val(b[10]));
        uint8 ver = uint8(hdr50 >> 42);
        uint8 codec = uint8(hdr50 >> 34);
        uint8 mh0 = uint8(hdr50 >> 26);
        uint8 mh1 = uint8(hdr50 >> 18);
        uint8 mh2 = uint8(hdr50 >> 10);
        uint8 mh3 = uint8(hdr50 >> 2);

        if (ver != 0x01) return false;
        if (codec != 0x70 && codec != 0x55 && codec != 0x71) return false;

        bool validHashLen = (len == 59 && mh0 == 0x12 && mh1 == 0x20) ||
            (len == 110 && mh0 == 0x13 && mh1 == 0x40) ||
            (len == 62 && mh0 == 0xa0 && mh1 == 0xe4 && mh2 == 0x02 && mh3 == 0x20);
        if (!validHashLen) return false;

        uint8 lastVal = _base32Val(b[len - 1]);
        uint8 trailingBits = uint8(((len - 1) * 5) & 7);
        if (trailingBits > 0 && (lastVal & ((uint8(1) << trailingBits) - 1)) != 0) return false;
        return true;
    }

    function _isAllHexWord(uint256 word) internal pure returns (bool ok) {
        assembly {
            let m80 := 0x8080808080808080808080808080808080808080808080808080808080808080
            let m20 := 0x2020202020202020202020202020202020202020202020202020202020202020
            let ascii := not(word)
            let wm := or(word, m80)
            let dig := and(
                and(ascii, sub(wm, 0x3030303030303030303030303030303030303030303030303030303030303030)),
                and(not(sub(wm, 0x3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a)), m80)
            )
            let lm := or(or(word, m20), m80)
            let alp := and(
                and(ascii, sub(lm, 0x6161616161616161616161616161616161616161616161616161616161616161)),
                and(not(sub(lm, 0x6767676767676767676767676767676767676767676767676767676767676767)), m80)
            )
            ok := eq(or(dig, alp), m80)
        }
    }

    function _scanKeyCipherHex(
        bytes calldata b,
        uint256 pos,
        uint256 len
    ) internal pure returns (uint256 nextPos, bool ok) {
        uint256 p = pos;
        bool nonZero;
        while (!(len < p + 32)) {
            uint256 word;
            assembly {
                word := calldataload(add(b.offset, p))
            }
            if (!_isAllHexWord(word)) break;
            if (word != 0x3030303030303030303030303030303030303030303030303030303030303030) nonZero = true;
            unchecked {
                p += 32;
            }
        }
        assembly {
            let base := b.offset
            let closed := 0
            for { } lt(p, len) { } {
                let word := calldataload(add(base, p))
                let chunk := sub(len, p)
                if gt(chunk, 32) { chunk := 32 }
                for { let k := 0 } lt(k, chunk) { k := add(k, 1) } {
                    let c := byte(k, word)
                    if eq(c, 0x22) { p := add(p, k) closed := 1 break }
                    let lo := or(c, 0x20)
                    if iszero(or(and(gt(c, 0x2f), lt(c, 0x3a)), and(gt(lo, 0x60), lt(lo, 0x67)))) { closed := 2 break }
                    if iszero(eq(c, 0x30)) { nonZero := 1 }
                }
                if closed { break }
                p := add(p, chunk)
            }
            if eq(closed, 1) {
                let hLen := sub(p, pos)
                if and(nonZero, and(gt(hLen, 511), iszero(and(hLen, 1)))) { nextPos := p ok := 1 }
            }
        }
    }

    function _validateEscape(bytes calldata b, uint256 escIdx, uint256 len) internal pure returns (uint256 nextP, bool ok) {
        if (!(escIdx < len)) return (0, false);
        bytes1 e = b[escIdx];
        if (e == "u") {
            if (!(escIdx + 4 < len)) return (0, false);
            for (uint256 j = 1; j < 5; ) {
                bytes1 h = b[escIdx + j];
                bytes1 lo = h | 0x20;
                if (!((h > 0x2f && h < 0x3a) || (lo > 0x60 && lo < 0x67))) return (0, false);
                unchecked {
                    ++j;
                }
            }
            return (escIdx + 5, true);
        }
        if (
            e == 0x22 || e == 0x5c || e == "/" || e == "b" ||
            e == "f" || e == "n" || e == "r" || e == "t"
        ) {
            return (escIdx + 1, true);
        }
        return (0, false);
    }

    function _scanJsonString(
        bytes calldata b,
        uint256 pos,
        uint256 len,
        bool isKey
    ) internal pure returns (uint256 nextPos, bool ok) {
        uint256 p = pos;
        while (p < len) {
            uint256 hitIdx;
            uint256 hitType;
            assembly {
                let base := b.offset
                let cur := p
                let m80 := 0x8080808080808080808080808080808080808080808080808080808080808080
                let m01 := 0x0101010101010101010101010101010101010101010101010101010101010101
                let m20 := 0x2020202020202020202020202020202020202020202020202020202020202020
                let m22 := 0x2222222222222222222222222222222222222222222222222222222222222222
                let m5c := 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c
                for { } lt(cur, len) { } {
                    let word := calldataload(add(base, cur))
                    let rem := sub(len, cur)
                    if iszero(lt(rem, 32)) {
                        let badCtrl := and(not(or(word, sub(or(word, m80), m20))), m80)
                        let xq := xor(word, m22)
                        let badQ := and(not(or(xq, sub(or(xq, m80), m01))), m80)
                        let xs := xor(word, m5c)
                        let badS := and(not(or(xs, sub(or(xs, m80), m01))), m80)
                        if iszero(or(badCtrl, or(badQ, badS))) {
                            cur := add(cur, 32)
                            continue
                        }
                    }
                    let chunk := rem
                    if gt(chunk, 32) { chunk := 32 }
                    for { let k := 0 } lt(k, chunk) { k := add(k, 1) } {
                        let c := byte(k, word)
                        if lt(c, 0x20) { hitType := 3 break }
                        if eq(c, 0x22) { hitIdx := add(cur, k) hitType := 1 break }
                        if eq(c, 0x5c) { hitIdx := add(cur, k) hitType := 2 break }
                    }
                    if hitType { break }
                    cur := add(cur, chunk)
                }
            }
            if (hitType == 1) return (hitIdx, true);
            if (hitType != 2 || isKey) return (0, false);
            (p, ok) = _validateEscape(b, hitIdx + 1, len);
            if (!ok) return (0, false);
        }
        return (0, false);
    }

    function _skipDigits(bytes calldata b, uint256 p, uint256 len) internal pure returns (uint256) {
        while (p < len && b[p] > 0x2f && b[p] < 0x3a) {
            unchecked {
                ++p;
            }
        }
        return p;
    }

    function _scanJsonNumber(
        bytes calldata b,
        uint256 pos,
        uint256 len
    ) internal pure returns (uint256 nextPos, bool ok) {
        uint256 p = pos;
        if (b[p] == "-") {
            unchecked { ++p; }
            if (!(p < len)) return (0, false);
        }
        bytes1 d0 = b[p];
        if (d0 == "0") {
            unchecked { ++p; }
            if (p < len && b[p] > 0x2f && b[p] < 0x3a) return (0, false);
        } else if (d0 > 0x30 && d0 < 0x3a) {
            p = _skipDigits(b, p + 1, len);
        } else {
            return (0, false);
        }
        if (p < len && b[p] == ".") {
            uint256 next = _skipDigits(b, p + 1, len);
            if (next == p + 1) return (0, false);
            p = next;
        }
        if (p < len && (b[p] == "e" || b[p] == "E")) {
            unchecked { ++p; }
            if (p < len && (b[p] == "+" || b[p] == "-")) { unchecked { ++p; } }
            uint256 next = _skipDigits(b, p, len);
            if (next == p) return (0, false);
            p = next;
        }
        return (p - 1, true);
    }

    function _isKeyCipherKey(bytes calldata b, uint256 start, uint256 end) internal pure returns (bool) {
        return (end - start == 9) && bytes8(b[start:start + 8]) == "keyCiphe" && b[start + 8] == "r";
    }

    function _isJsonWs(bytes1 c) internal pure returns (bool) {
        return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d;
    }

    function _parseKeyToken(
        bytes calldata b,
        uint256 i,
        uint256 len,
        uint8 st,
        uint8 depth
    ) internal pure returns (uint256, uint8, uint8, bool, bool) {
        bytes1 c = b[i];
        if (st == 1 && c == "}") {
            if (depth == 0) return (0, 0, 0, false, false);
            return (i, 8, depth - 1, false, true);
        }
        if (c != 0x22) return (0, 0, 0, false, false);
        (uint256 endPos, bool ok) = _scanJsonString(b, i + 1, len, true);
        if (!ok) return (0, 0, 0, false, false);
        bool curKC = false;
        if (depth == 0) {
            if (endPos == i + 1) return (0, 0, 0, false, false);
            curKC = _isKeyCipherKey(b, i + 1, endPos);
        }
        return (endPos, 4, depth, curKC, true);
    }

    /**
     * @notice Pure RFC 8259 JSON capsule validator enforcing a single non-zero RSA-OAEP `keyCipher`
     *         of >= 512 even hex characters, rejecting `\uXXXX`/escape key shadowing, duplicate `keyCipher`,
     *         and malformed JSON while using word-loaded fast-path hex/string scanning for low gas.
     * @param capsule Serialized JSON key capsule string (528..8192 bytes).
     * @return valid True if the capsule strictly satisfies RFC 8259 and key encapsulation invariants.
     */
    function validateCapsule(string calldata capsule) external pure returns (bool valid) {
        bytes calldata b = bytes(capsule);
        uint256 len = b.length;
        if (len < 528 || len > 8192) return false;

        uint8 st = 0;
        uint8 depth = 0;
        uint64 stack = 0;
        bool curKC = false;
        bool hasKC = false;
        bool allowCloseArr = false;

        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            if (!_isJsonWs(c)) {
                bool ok = true;
                if (st == 0) {
                    if (c != "{") return false;
                    st = 1;
                } else if (st == 1 || st == 2) {
                    (i, st, depth, curKC, ok) = _parseKeyToken(b, i, len, st, depth);
                } else if (st == 4) {
                    if (c != ":") return false;
                    allowCloseArr = false;
                    st = 5;
                } else if (st == 5) {
                    (i, st, depth, stack, allowCloseArr, hasKC, curKC, ok) = _parseJsonValue(
                        b, i, len, depth, stack, allowCloseArr, hasKC, curKC
                    );
                } else if (st == 8) {
                    bool inArr = ((stack >> depth) & 1) == 1;
                    if (c == ",") { allowCloseArr = false; st = inArr ? 5 : 2; }
                    else if ((inArr && c == "]") || (!inArr && c == "}")) { if (depth == 0) st = 9; else --depth; }
                    else return false;
                } else {
                    return false;
                }
                if (!ok) return false;
            }
            unchecked { ++i; }
        }
        return hasKC && st == 9;
    }

    function _parseJsonValue(
        bytes calldata b,
        uint256 i,
        uint256 len,
        uint8 depth,
        uint64 stack,
        bool allowCloseArr,
        bool hasKC,
        bool curKC
    ) internal pure returns (uint256, uint8, uint8, uint64, bool, bool, bool, bool) {
        bytes1 c = b[i];
        if (allowCloseArr && c == "]") {
            return (i, 8, depth - 1, stack, false, hasKC, curKC, true);
        }
        if (c == 0x22) {
            uint256 endPos;
            bool ok;
            if (curKC) {
                if (hasKC) return (0, 0, 0, 0, false, false, false, false);
                (endPos, ok) = _scanKeyCipherHex(b, i + 1, len);
                return (endPos, 8, depth, stack, false, true, false, ok);
            }
            (endPos, ok) = _scanJsonString(b, i + 1, len, false);
            return (endPos, 8, depth, stack, false, hasKC, false, ok);
        }
        if (curKC) return (0, 0, 0, 0, false, false, false, false);
        if (c == "{" || c == "[") {
            if (depth > 30) return (0, 0, 0, 0, false, false, false, false);
            uint8 nextDepth = depth + 1;
            if (c == "[") {
                return (i, 5, nextDepth, stack | (uint64(1) << nextDepth), true, hasKC, false, true);
            }
            return (i, 1, nextDepth, stack & ~(uint64(1) << nextDepth), false, hasKC, false, true);
        }
        if (c == "-" || (c > 0x2f && c < 0x3a)) {
            (uint256 endPos, bool ok) = _scanJsonNumber(b, i, len);
            return (endPos, 8, depth, stack, false, hasKC, false, ok);
        }
        if (i + 3 < len && (bytes4(b[i:i + 4]) == "true" || bytes4(b[i:i + 4]) == "null")) {
            return (i + 3, 8, depth, stack, false, hasKC, false, true);
        }
        if (i + 4 < len && bytes5(b[i:i + 5]) == "false") {
            return (i + 4, 8, depth, stack, false, hasKC, false, true);
        }
        return (0, 0, 0, 0, false, false, false, false);
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
        if (from != address(0) && to != address(0) && from != to && registryContract.code.length > 0) {
            IGenomicsRegistryWorkerSync(registryContract).resetAuthorizedWorkersForToken(tokenId);
        }
        return from;
    }

    /**
     * @notice Check ERC-165 interface support for ERC721URIStorage and ERC2981.
     * @param interfaceId 4-byte ERC-165 interface identifier.
     * @return supported True if the interface is supported.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC2981)
        returns (bool supported)
    {
        return ERC721URIStorage.supportsInterface(interfaceId) || ERC2981.supportsInterface(interfaceId);
    }
}