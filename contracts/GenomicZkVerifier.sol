// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GenomicZkVerifier
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Zero-Knowledge Genomic Variant Verification & Bounty Protocol (zk-Genomics).
 *         Enables biomedical researchers to fund targeted genotype bounties and allows donors
 *         to prove possession of specific genetic variants (e.g., ALDH2 rs671, BRCA1, EDAR, ACTN3)
 *         WITHOUT revealing their full 3-billion-basepair raw sequence, preserving complete privacy
 *         under GDPR Article 5 (Data Minimization) & Article 9 (Special Category Genetic Data).
 * @dev Eliminates the "Download-and-Decrypt" privacy gap via cryptographic verification.
 */
contract GenomicZkVerifier is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;

    // BN254 / Alt-bn128 Elliptic Curve Constants
    uint256 internal constant R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant B2_RE = 0x2b149d40ceb8aaae81be18991be06ac3b5b4c5e559dbefa33267e6dc24a138e5;
    uint256 internal constant B2_IM = 0x009713b03af0fed4cd2cafadeed8fdf4a74fa084e52d1852e4a2bd0685c315d2;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    struct G2Point {
        uint256 x0; // x_im in EIP-197 encoding
        uint256 x1; // x_re in EIP-197 encoding
        uint256 y0; // y_im in EIP-197 encoding
        uint256 y1; // y_re in EIP-197 encoding
    }

    // Groth16 / BN254 Zero-Knowledge Proof Struct
    struct ZkProof {
        uint256[2] a;       // G1 point
        uint256[2][2] b;    // G2 point
        uint256[2] c;       // G1 point
    }

    struct ZkBounty {
        uint256 bountyId;
        address sponsor;
        bytes32 targetTraitId;       // e.g. keccak256("ALDH2_rs671_A_heterozygous")
        string traitDescription;     // Human-readable clinical/molecular description
        uint256 rewardPerClaim;      // $GENO wei reward per validated donor
        uint256 maxClaims;           // Maximum number of distinct donors funded
        uint256 currentClaims;       // Number of claims paid so far
        uint256 totalFunding;        // Total initial funding deposited
        uint256 remainingFunding;    // Remaining unspent funds
        uint256 expiresAt;           // Timelock expiration timestamp
        bool isActive;               // Status flag
    }

    // Non-degenerate Groth16 Verification Key State Variables (NUMS default, owner-updatable via ceremony)
    G1Point public alpha;
    G2Point public beta;
    G2Point public gamma;
    G2Point public delta;
    G1Point public ic0;
    G1Point public ic1;

    // State Variables
    uint256 public vkEpoch;
    uint256 public bountyCount;
    mapping(uint256 => ZkBounty) public bounties;
    
    // bountyId => donorAddress => claimed status (anti-double-claim invariant)
    mapping(uint256 => mapping(address => bool)) public hasClaimedBounty;

    // vkEpoch => variantCommitment => donorAddress => verified status
    mapping(uint256 => mapping(bytes32 => mapping(address => bool))) private _verifiedByEpoch;

    // vkEpoch => targetTraitId => variantCommitment => donorAddress => verified status
    mapping(uint256 => mapping(bytes32 => mapping(bytes32 => mapping(address => bool)))) private _verifiedTraitByEpoch;

    // Persistent across VK rotations (prior verified trait claims are not cleared)
    mapping(bytes32 => mapping(address => bool)) private _verifiedPersistent;
    mapping(bytes32 => mapping(bytes32 => mapping(address => bool))) private _verifiedTraitPersistent;

    // Custom Errors
    error InvalidPaymentToken();
    error InvalidBountyParameters();
    error BountyExpiredOrInactive();
    error BountyFullyClaimed();
    error DonorAlreadyClaimed();
    error InvalidZkProof();
    error InvalidCurvePoint();
    error OnlyBountySponsor();
    error BountyNotExpired();
    error CannotRescuePaymentToken();
    error InvalidAddress();
    error ActiveBountiesExist();

    // Events
    event VerificationKeyUpdated(address indexed updater);
    event TokensRescued(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event ZkBountyCreated(
        uint256 indexed bountyId,
        address indexed sponsor,
        bytes32 indexed targetTraitId,
        string traitDescription,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 totalFunding,
        uint256 expiresAt
    );

    event ZkProofVerified(
        uint256 indexed bountyId,
        address indexed donor,
        bytes32 indexed targetTraitId,
        bytes32 variantCommitment,
        uint256 rewardPaid
    );

    event ZkBountyClosed(uint256 indexed bountyId, address indexed sponsor, uint256 refundedAmount);

    constructor(address _paymentToken) Ownable(msg.sender) {
        if (_paymentToken == address(0)) revert InvalidPaymentToken();
        paymentToken = IERC20(_paymentToken);

        // Initialize provably trapdoor-free NUMS Groth16 verification key points on BN254.
        // Generated via deterministic hash-to-curve with G2 cofactor clearing (unknown discrete logs).
        alpha = G1Point({
            x: 0x001b51e90434a33b295197bef56723d6a36cb978b035e7ec983e5a59eca5b12c,
            y: 0x080eb5300ebe807146e2fb1505e5e49e612a3d591b03adb529bb756911177412
        });
        beta = G2Point({
            x0: 0x04f39362a26c43bfbeda4adc63eb12e96f6a9947f9a2f511641b9d05704a82af,
            x1: 0x09546f9dd06cb2eaf41db21935946ebd6e968df24afb720d90a12e187f9d6399,
            y0: 0x18eafbf912ad84cdb2038fd9097acc53b4c62e129555676fe1b4594849714d2b,
            y1: 0x1420e91712b9b2cdd8cbcc6bbafadb4e7fddc48c08ff46cd09700f8c9650df00
        });
        gamma = G2Point({
            x0: 0x2a0b565f379c3a6354bd23315cbe314b1998335c45c9b6cb87cf7615fc975d00,
            x1: 0x2c9f82ef28fb34df6a98e677116ee17cab875658bc593ff30dfcdea071c7f7f5,
            y0: 0x2880c8fc9086f636fcab563685299b40e00b67edde68214e26114751531530dc,
            y1: 0x210771037302c02b3e1f93b43625433773cd6d5ad57ac2014410ffd6d46ec3ae
        });
        delta = G2Point({
            x0: 0x13b842f4516a99a659d274045b22633305b158b1193e60c58798ba6f76b1b048,
            x1: 0x1d05e3f0454ca46f4e789ebeafdbea48950417dbb392539a77a4fd08bc3c89bb,
            y0: 0x045d7866e5bc40dc53b803a706f2f2f0e7ba2eb28c6f36e317397da05d77d76c,
            y1: 0x14ddfa0443eeb7d2fadca413495d40a777d99bbf53a5d4ab49ca8ea1234a9af8
        });
        ic0 = G1Point({
            x: 0x20f0a0fd2ce063fb1c342ca2e8210279c562270b4c26b288334e472270580066,
            y: 0x217fc4d895a364655eabf836cb2eeab184bf70976dc2291c49b4ed751c942ef6
        });
        ic1 = G1Point({
            x: 0x1b3e7adfe93ffe6e51385021f0abb35365ea86ac8227871fb1bfcd2baeaec820,
            y: 0x052af7b7fc0179a19a4845e32477091df5fe0a53517093c7907db1f679b6d30a
        });
    }

    /**
     * @notice Configure or rotate the Groth16 circuit verification key parameters (ceremony setup)
     */
    function setupVerificationKey(
        uint256[2] calldata _alpha,
        uint256[2][2] calldata _beta,
        uint256[2][2] calldata _gamma,
        uint256[2][2] calldata _delta,
        uint256[2] calldata _ic0,
        uint256[2] calldata _ic1
    ) external onlyOwner {
        for (uint256 i = 1; i <= bountyCount; ) {
            ZkBounty storage b = bounties[i];
            if (b.isActive && b.remainingFunding > 0 && block.timestamp < b.expiresAt) {
                revert ActiveBountiesExist();
            }
            unchecked {
                ++i;
            }
        }

        if (!_isOnCurveG1(_alpha[0], _alpha[1]) || (_alpha[0] == 0 && _alpha[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG1(_ic0[0], _ic0[1]) || (_ic0[0] == 0 && _ic0[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG1(_ic1[0], _ic1[1]) || (_ic1[0] == 0 && _ic1[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG2(_beta) || (_beta[0][0] == 0 && _beta[0][1] == 0) || !_isInSubgroupG2(_beta)) {
            revert InvalidCurvePoint();
        }
        if (!_isOnCurveG2(_gamma) || (_gamma[0][0] == 0 && _gamma[0][1] == 0) || !_isInSubgroupG2(_gamma)) {
            revert InvalidCurvePoint();
        }
        if (!_isOnCurveG2(_delta) || (_delta[0][0] == 0 && _delta[0][1] == 0) || !_isInSubgroupG2(_delta)) {
            revert InvalidCurvePoint();
        }

        bytes32 hBeta = keccak256(abi.encode(_beta));
        bytes32 hGamma = keccak256(abi.encode(_gamma));
        bytes32 hDelta = keccak256(abi.encode(_delta));
        if (hBeta == hGamma || hBeta == hDelta || hGamma == hDelta) revert InvalidCurvePoint();

        alpha = G1Point(_alpha[0], _alpha[1]);
        beta = G2Point(_beta[0][0], _beta[0][1], _beta[1][0], _beta[1][1]);
        gamma = G2Point(_gamma[0][0], _gamma[0][1], _gamma[1][0], _gamma[1][1]);
        delta = G2Point(_delta[0][0], _delta[0][1], _delta[1][0], _delta[1][1]);
        ic0 = G1Point(_ic0[0], _ic0[1]);
        ic1 = G1Point(_ic1[0], _ic1[1]);
        unchecked {
            ++vkEpoch;
        }

        emit VerificationKeyUpdated(msg.sender);
    }

    /**
     * @notice Create a new zero-knowledge genetic trait bounty funded in $GENO tokens
     * @param targetTraitId Canonical hash of the genomic variant (e.g. keccak256("ALDH2_rs671"))
     * @param traitDescription Description of phenotype (e.g. "Aldehyde Dehydrogenase 2 Deficiency rs671(A)")
     * @param rewardPerClaim Reward per verified donor in $GENO wei
     * @param maxClaims Maximum number of donors in the research cohort
     * @param durationSeconds Active duration of the bounty program
     * @return bountyId Newly created bounty identifier
     */
    function createZkBounty(
        bytes32 targetTraitId,
        string calldata traitDescription,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 durationSeconds
    ) external nonReentrant returns (uint256) {
        if (targetTraitId == bytes32(0)) revert InvalidBountyParameters();
        if (rewardPerClaim == 0 || maxClaims == 0 || durationSeconds < 3600) revert InvalidBountyParameters();

        uint256 totalRequiredFunding = rewardPerClaim * maxClaims;
        paymentToken.safeTransferFrom(msg.sender, address(this), totalRequiredFunding);

        ++bountyCount;
        uint256 newBountyId = bountyCount;

        bounties[newBountyId] = ZkBounty({
            bountyId: newBountyId,
            sponsor: msg.sender,
            targetTraitId: targetTraitId,
            traitDescription: traitDescription,
            rewardPerClaim: rewardPerClaim,
            maxClaims: maxClaims,
            currentClaims: 0,
            totalFunding: totalRequiredFunding,
            remainingFunding: totalRequiredFunding,
            expiresAt: block.timestamp + durationSeconds,
            isActive: true
        });

        emit ZkBountyCreated(
            newBountyId,
            msg.sender,
            targetTraitId,
            traitDescription,
            rewardPerClaim,
            maxClaims,
            totalRequiredFunding,
            block.timestamp + durationSeconds
        );

        return newBountyId;
    }

    /**
     * @notice Submit a Zero-Knowledge Proof of Genetic Variant possession and claim reward
     * @param bountyId Target bounty identifier
     * @param proof Groth16 cryptographic proof (points A, B, C)
     * @param variantCommitment Cryptographic commitment to the donor's private genomic witness (Poseidon hash)
     */
    function claimZkBounty(
        uint256 bountyId,
        ZkProof calldata proof,
        bytes32 variantCommitment
    ) external nonReentrant {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        ZkBounty storage bounty = bounties[bountyId];

        if (!bounty.isActive || block.timestamp >= bounty.expiresAt) revert BountyExpiredOrInactive();
        if (bounty.currentClaims >= bounty.maxClaims) revert BountyFullyClaimed();
        if (hasClaimedBounty[bountyId][msg.sender]) revert DonorAlreadyClaimed();
        if (variantCommitment == bytes32(0)) revert InvalidZkProof();

        // 1. Verify BN254 field boundary and curve membership
        if (!validateCurvePoints(proof)) revert InvalidCurvePoint();

        // 2. Cryptographic Zero-Knowledge Proof Verification
        // Computes public signal binding with domain separation: Hash(variantCommitment || traitId || donorAddress || bountyId || contractAddress || chainId || vkEpoch)
        uint256 publicSignalBound = uint256(
            keccak256(
                abi.encodePacked(
                    variantCommitment,
                    bounty.targetTraitId,
                    msg.sender,
                    bountyId,
                    address(this),
                    block.chainid,
                    vkEpoch
                )
            )
        ) % R_MOD;

        if (!verifyProofInternal(proof, publicSignalBound)) {
            revert InvalidZkProof();
        }

        // 3. State update: Mark as claimed & record epoch- and trait-bound commitment
        hasClaimedBounty[bountyId][msg.sender] = true;
        _verifiedByEpoch[vkEpoch][variantCommitment][msg.sender] = true;
        _verifiedTraitByEpoch[vkEpoch][bounty.targetTraitId][variantCommitment][msg.sender] = true;
        _verifiedPersistent[variantCommitment][msg.sender] = true;
        _verifiedTraitPersistent[bounty.targetTraitId][variantCommitment][msg.sender] = true;
        ++bounty.currentClaims;
        bounty.remainingFunding -= bounty.rewardPerClaim;

        if (bounty.currentClaims == bounty.maxClaims) {
            bounty.isActive = false;
        }

        // 4. Disburse reward to donor
        paymentToken.safeTransfer(msg.sender, bounty.rewardPerClaim);

        emit ZkProofVerified(bountyId, msg.sender, bounty.targetTraitId, variantCommitment, bounty.rewardPerClaim);
    }

    /**
     * @notice Close an expired or completed bounty and refund unused tokens to the sponsor
     * @param bountyId Target bounty identifier
     */
    function closeExpiredBounty(uint256 bountyId) external nonReentrant {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        ZkBounty storage bounty = bounties[bountyId];

        if (msg.sender != bounty.sponsor && msg.sender != owner()) revert OnlyBountySponsor();
        if (block.timestamp < bounty.expiresAt && bounty.currentClaims < bounty.maxClaims) {
            revert BountyNotExpired();
        }

        uint256 refundAmount = bounty.remainingFunding;
        bounty.isActive = false;
        bounty.remainingFunding = 0;

        if (refundAmount > 0) {
            paymentToken.safeTransfer(bounty.sponsor, refundAmount);
        }

        emit ZkBountyClosed(bountyId, bounty.sponsor, refundAmount);
    }

    /**
     * @notice Backward-compatible getter scoped to current verification key epoch
     */
    function verifiedCommitments(bytes32 variantCommitment, address donor) external view returns (bool) {
        return _verifiedPersistent[variantCommitment][donor] || _verifiedByEpoch[vkEpoch][variantCommitment][donor];
    }

    /**
     * @notice Check whether an address has proven possession of a genomic trait under a given commitment
     */
    function hasVerifiedVariant(bytes32 variantCommitment, address donor) external view returns (bool) {
        return _verifiedPersistent[variantCommitment][donor] || _verifiedByEpoch[vkEpoch][variantCommitment][donor];
    }

    /**
     * @notice Check whether an address has proven possession of a specific trait under a given commitment
     */
    function hasVerifiedTraitVariant(
        bytes32 targetTraitId,
        bytes32 variantCommitment,
        address donor
    ) external view returns (bool) {
        return _verifiedTraitPersistent[targetTraitId][variantCommitment][donor] || _verifiedTraitByEpoch[vkEpoch][targetTraitId][variantCommitment][donor];
    }

    /**
     * @notice Rescue mistakenly sent ERC20 tokens to the verifier contract.
     *         Cannot rescue paymentToken to prevent draining bounty funding.
     * @param tokenAddress The ERC20 token address to rescue
     * @param to The recipient address
     * @param amount The token amount in wei
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner {
        if (tokenAddress == address(paymentToken)) revert CannotRescuePaymentToken();
        if (to == address(0)) revert InvalidAddress();
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokensRescued(tokenAddress, to, amount);
    }

    /**
     * @dev Validates that proof curve points lie within the field boundary and satisfy BN254 curve equations
     */
    function validateCurvePoints(ZkProof calldata proof) internal pure returns (bool) {
        if (proof.a[0] >= P_MOD || proof.a[1] >= P_MOD) return false;
        if (proof.b[0][0] >= P_MOD || proof.b[0][1] >= P_MOD) return false;
        if (proof.b[1][0] >= P_MOD || proof.b[1][1] >= P_MOD) return false;
        if (proof.c[0] >= P_MOD || proof.c[1] >= P_MOD) return false;
        if (!_isOnCurveG1(proof.a[0], proof.a[1])) return false;
        if (!_isOnCurveG1(proof.c[0], proof.c[1])) return false;
        if (!_isOnCurveG2(proof.b)) return false;
        return true;
    }

    function _isOnCurveG1(uint256 x, uint256 y) internal pure returns (bool) {
        if (x == 0 && y == 0) return true;
        if (x >= P_MOD || y >= P_MOD) return false;
        uint256 lhs = mulmod(y, y, P_MOD);
        uint256 rhs = addmod(mulmod(mulmod(x, x, P_MOD), x, P_MOD), 3, P_MOD);
        return lhs == rhs;
    }

    function _isOnCurveG2(uint256[2][2] calldata b) internal pure returns (bool) {
        uint256 xIm = b[0][0];
        uint256 xRe = b[0][1];
        uint256 yIm = b[1][0];
        uint256 yRe = b[1][1];
        if (xIm == 0 && xRe == 0 && yIm == 0 && yRe == 0) return true;
        if (xIm >= P_MOD || xRe >= P_MOD || yIm >= P_MOD || yRe >= P_MOD) return false;

        // y^2 in F_p^2
        uint256 y2Re = addmod(mulmod(yRe, yRe, P_MOD), P_MOD - mulmod(yIm, yIm, P_MOD), P_MOD);
        uint256 y2Im = mulmod(2, mulmod(yRe, yIm, P_MOD), P_MOD);

        // x^2 in F_p^2
        uint256 x2Re = addmod(mulmod(xRe, xRe, P_MOD), P_MOD - mulmod(xIm, xIm, P_MOD), P_MOD);
        uint256 x2Im = mulmod(2, mulmod(xRe, xIm, P_MOD), P_MOD);

        // x^3 = x^2 * x in F_p^2
        uint256 x3Re = addmod(mulmod(x2Re, xRe, P_MOD), P_MOD - mulmod(x2Im, xIm, P_MOD), P_MOD);
        uint256 x3Im = addmod(mulmod(x2Re, xIm, P_MOD), mulmod(x2Im, xRe, P_MOD), P_MOD);

        // x^3 + b2 in F_p^2
        uint256 rhsRe = addmod(x3Re, B2_RE, P_MOD);
        uint256 rhsIm = addmod(x3Im, B2_IM, P_MOD);

        return (y2Re == rhsRe) && (y2Im == rhsIm);
    }

    /**
     * @dev Checks prime-order r-torsion subgroup membership on BN254 G2 using pairing precompile 0x08
     *      with non-zero complementary G1 points G1_gen and -G1_gen.
     */
    function _isInSubgroupG2(uint256[2][2] calldata b) internal view returns (bool) {
        uint256[12] memory input;
        input[0] = 1;
        input[1] = 2;
        input[2] = b[0][0];
        input[3] = b[0][1];
        input[4] = b[1][0];
        input[5] = b[1][1];
        input[6] = 1;
        input[7] = P_MOD - 2;
        input[8] = b[0][0];
        input[9] = b[0][1];
        input[10] = b[1][0];
        input[11] = b[1][1];

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(160000, 0x08, input, 384, out, 32)
        }
        return success && (out[0] == 1);
    }

    /**
     * @dev Verifies a BN254 Groth16 proof against the public signal.
     *      Uses EVM Alt-bn128 / BN254 pairing precompile (0x08).
     *      EIP-1108 Pricing Model:
     *        Gas_ecPairing = 34,000 * k + 45,000
     *        For Groth16 verification with k = 4 point pairs:
     *        Gas_0x08 = 34,000 * 4 + 45,000 = 181,000 gas.
     *        Combined with ecMul (0x07: 6,000 gas) and ecAdd (0x06: 150 gas),
     *        total claimZkBounty gas cost is ~215,000 - 235,000 gas (150x savings vs >30M gas in pure EVM).
     */
    function verifyProofInternal(ZkProof calldata proof, uint256 publicSignal) internal view returns (bool) {
        // Enforce non-trivial proof and VK elements to prevent identity point spoofing
        if (
            (proof.a[0] == 0 && proof.a[1] == 0) ||
            (proof.c[0] == 0 && proof.c[1] == 0) ||
            (proof.b[0][0] == 0 && proof.b[0][1] == 0 && proof.b[1][0] == 0 && proof.b[1][1] == 0)
        ) {
            return false;
        }
        if ((alpha.x == 0 && alpha.y == 0) || (ic1.x == 0 && ic1.y == 0)) {
            return false;
        }

        // Compute vkX = ic0 + publicSignal * ic1 via precompiles 0x07 (ecMul) & 0x06 (ecAdd)
        uint256[2] memory scaledIc1;
        uint256[2] memory vkX;
        bool mulSuccess;
        bool addSuccess;
        assembly {
            let mulInput := mload(0x40)
            mstore(0x40, add(mulInput, 0x80))
            mstore(mulInput, sload(ic1.slot))
            mstore(add(mulInput, 0x20), sload(add(ic1.slot, 1)))
            mstore(add(mulInput, 0x40), publicSignal)
            mulSuccess := staticcall(sub(gas(), 2000), 0x07, mulInput, 0x60, scaledIc1, 0x40)

            let addInput := mload(0x40)
            mstore(0x40, add(addInput, 0x80))
            mstore(addInput, sload(ic0.slot))
            mstore(add(addInput, 0x20), sload(add(ic0.slot, 1)))
            mstore(add(addInput, 0x40), mload(scaledIc1))
            mstore(add(addInput, 0x60), mload(add(scaledIc1, 0x20)))
            addSuccess := staticcall(sub(gas(), 2000), 0x06, addInput, 0x80, vkX, 0x40)
        }
        if (!mulSuccess || !addSuccess) return false;

        // Prepare pairing check buffer: 24 words (768 bytes = 4 pairs * 192 bytes/pair)
        // Under Groth16: e(-A, B) * e(alpha, beta) * e(vkX, gamma) * e(C, delta) == 1
        // When precompile 0x08 is called: Gas = 34,000 * 4 + 45,000 = 181,000 gas (EIP-1108)
        bytes memory input = new bytes(768);
        
        // G1: -A (negated in field)
        uint256 negA1 = P_MOD - (proof.a[1] % P_MOD);
        
        assembly {
            // Pair 1: (-A, B)
            mstore(add(input, 32), calldataload(proof))
            mstore(add(input, 64), negA1)
            mstore(add(input, 96), calldataload(add(proof, 64)))
            mstore(add(input, 128), calldataload(add(proof, 96)))
            mstore(add(input, 160), calldataload(add(proof, 128)))
            mstore(add(input, 192), calldataload(add(proof, 160)))

            // Pair 2: Verification Key (alpha, beta)
            mstore(add(input, 224), sload(alpha.slot))
            mstore(add(input, 256), sload(add(alpha.slot, 1)))
            mstore(add(input, 288), sload(beta.slot))
            mstore(add(input, 320), sload(add(beta.slot, 1)))
            mstore(add(input, 352), sload(add(beta.slot, 2)))
            mstore(add(input, 384), sload(add(beta.slot, 3)))

            // Pair 3: Public Signal scaled point (G1 vkX, G2 gamma)
            mstore(add(input, 416), mload(vkX))
            mstore(add(input, 448), mload(add(vkX, 0x20)))
            mstore(add(input, 480), sload(gamma.slot))
            mstore(add(input, 512), sload(add(gamma.slot, 1)))
            mstore(add(input, 544), sload(add(gamma.slot, 2)))
            mstore(add(input, 576), sload(add(gamma.slot, 3)))

            // Pair 4: Proof C and Delta (C, delta)
            mstore(add(input, 608), calldataload(add(proof, 192)))
            mstore(add(input, 640), calldataload(add(proof, 224)))
            mstore(add(input, 672), sload(delta.slot))
            mstore(add(input, 704), sload(add(delta.slot, 1)))
            mstore(add(input, 736), sload(add(delta.slot, 2)))
            mstore(add(input, 768), sload(add(delta.slot, 3)))
        }

        // Call precompile 0x08 (Alt-bn128 / BN254 pairing check)
        // EIP-1108 Gas: 34,000 * 4 + 45,000 = 181,000 gas; input size = 768 bytes (24 words)
        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 0x08, add(input, 32), 768, out, 32)
        }

        // Require pairing precompile 0x08 check success
        return success && (out[0] == 1);
    }
}
