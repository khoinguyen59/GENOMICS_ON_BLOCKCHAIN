// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GenomicZkBountyStorage
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Abstract storage layout, packed ZkBounty struct, curve/proof structs, and events
 *         inherited by GenomicZkVerifier.
 * @dev Separates bounty/attestor state variables from the Groth16 BN254 verification key state
 *      to keep state counts modular and packs ZkBounty into 10 optimal storage slots.
 */
abstract contract GenomicZkBountyStorage {
    /// @notice BN254 G1 affine curve point (x, y).
    struct G1Point {
        uint256 x;
        uint256 y;
    }

    /// @notice BN254 G2 affine curve point in EIP-197 Fp2 ordering (x_im, x_re, y_im, y_re).
    struct G2Point {
        uint256 x0;
        uint256 x1;
        uint256 y0;
        uint256 y1;
    }

    /// @notice Groth16 zero-knowledge proof tuple (A in G1, B in G2, C in G1).
    struct ZkProof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    /// @notice Tightly packed ZK genotype bounty descriptor (sponsor + isActive packed in slot 1).
    struct ZkBounty {
        uint256 bountyId;
        address sponsor;
        bool isActive;
        bytes32 targetTraitId;
        string traitDescription;
        uint256 rewardPerClaim;
        uint256 maxClaims;
        uint256 currentClaims;
        uint256 totalFunding;
        uint256 remainingFunding;
        uint256 expiresAt;
    }

    /// @notice Minimum active duration for a ZK genotype bounty (1 hour).
    uint256 public constant MIN_BOUNTY_DURATION = 1 hours;
    /// @notice Maximum active duration for a ZK genotype bounty (365 days).
    uint256 public constant MAX_BOUNTY_DURATION = 365 days;
    /// @notice Minimum per-claim donor reward in $GENO wei (1 $GENO).
    uint256 public constant MIN_BOUNTY_REWARD = 1 ether;
    /// @notice Global ceiling on simultaneously active funded bounties (anti-DoS).
    uint256 public constant MAX_ACTIVE_BOUNTIES = 1024;
    /// @notice Maximum simultaneously active bounties allowed per individual sponsor.
    uint256 public constant MAX_ACTIVE_BOUNTIES_PER_SPONSOR = 4;

    uint256 internal constant BOUNTY_ID_MASK = (uint256(1) << 192) - 1;
    uint256 internal constant MAX_BATCH_PRUNE_STEPS = 256;
    uint256 internal constant MAX_ATTESTORS_PER_SLOT = 8;
    address internal constant UNATTESTED_ATTESTOR = address(1);

    /// @notice Total number of ZK bounties created.
    uint256 public bountyCount;
    /// @notice True when strict clinical sequencing-lab ECDSA attestation is required globally.
    bool public requireLabAttestation;
    /// @notice Approved clinical sequencing-lab ECDSA attestor allowlist.
    mapping(address => bool) public approvedLabAttestors;
    /// @notice Bounty ID to ZkBounty details.
    mapping(uint256 => ZkBounty) public bounties;
    /// @notice Bounty ID to required sequencing-lab attestor address (zero for unattested bounties).
    mapping(uint256 => address) public bountyRequiredAttestor;
    /// @notice Sponsor address to current count of active funded bounties.
    mapping(address => uint256) public sponsorActiveBounties;

    uint256 internal _activeBountyCount;
    uint256 internal _pruneCursor;
    uint256[] internal _activeBountyEntries;
    mapping(uint256 => uint256) internal _activeBountyIndex;
    mapping(address => uint256[]) internal _sponsorActiveBountyIds;
    mapping(uint256 => uint256) internal _sponsorBountyIndex;

    /// @notice Bounty ID => donor address => true once claimed (anti-double-claim invariant).
    mapping(uint256 => mapping(address => bool)) public hasClaimedBounty;

    /// @notice Single-use replay guard for ECDSA clinical lab attestation digests.
    mapping(bytes32 => bool) public usedLabAttestationDigests;

    /// @notice Epoch => domain-separated slot key => donor => bounded list of verifying attestors.
    mapping(uint256 => mapping(bytes32 => mapping(address => address[]))) internal _slotAttestors;

    /**
     * @notice Emitted whenever the Groth16 verification key is configured or rotated.
     * @param updater Governance address that performed the VK ceremony update.
     */
    event VerificationKeyUpdated(address indexed updater);

    /**
     * @notice Emitted when mistakenly sent non-payment ERC-20 tokens are rescued by governance.
     * @param token Rescued ERC-20 token address.
     * @param to Recipient address.
     * @param amount Rescued token amount in wei.
     */
    event TokensRescued(address indexed token, address indexed to, uint256 indexed amount);

    /**
     * @notice Emitted when a sponsor funds and opens a new ZK genotype bounty.
     * @param bountyId Newly created bounty identifier.
     * @param sponsor Sponsor address funding the bounty.
     * @param targetTraitId Canonical identifier of the targeted genetic trait.
     * @param traitDescription Human-readable clinical/molecular trait description.
     * @param rewardPerClaim Reward paid per verified donor in $GENO wei.
     * @param maxClaims Maximum distinct donor claims funded.
     * @param totalFunding Total escrowed $GENO funding.
     * @param expiresAt Bounty expiration timestamp.
     */
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

    /**
     * @notice Emitted alongside ZkBountyCreated when a bounty requires a sequencing-lab attestor.
     * @param bountyId Newly created bounty identifier.
     * @param requiredAttestor Trusted sequencing-lab ECDSA signer address.
     */
    event AttestedZkBountyCreated(uint256 indexed bountyId, address indexed requiredAttestor);

    /**
     * @notice Emitted when governance updates global lab attestation enforcement policy.
     * @param required True when unattested bounties/claims are blocked.
     */
    event LabAttestationPolicyUpdated(bool indexed required);

    /**
     * @notice Emitted when governance approves or revokes a sequencing-lab attestor.
     * @param lab Sequencing-lab ECDSA signer address.
     * @param approved True if approved, false if revoked.
     */
    event ApprovedLabAttestorUpdated(address indexed lab, bool indexed approved);

    /**
     * @notice Emitted when a donor verifies a dataset-bound lab-attested ZK trait proof.
     * @param bountyId Claimed bounty identifier.
     * @param donor Verified donor address.
     * @param targetTraitId Canonical genetic trait identifier.
     * @param rawDataHash Bound SHA-256 hash of the encrypted genomic dataset package.
     * @param variantCommitment Donor's MiMC-7 variant commitment.
     */
    event DatasetTraitAttested(
        uint256 indexed bountyId,
        address indexed donor,
        bytes32 indexed targetTraitId,
        bytes32 rawDataHash,
        bytes32 variantCommitment
    );

    /**
     * @notice Emitted when a donor's Groth16 proof passes BN254 pairing verification and pays out.
     * @param bountyId Claimed bounty identifier.
     * @param donor Verified donor address.
     * @param targetTraitId Canonical genetic trait identifier.
     * @param variantCommitment Donor's MiMC-7 variant commitment.
     * @param rewardPaid Disbursed $GENO reward in wei.
     */
    event ZkProofVerified(
        uint256 indexed bountyId,
        address indexed donor,
        bytes32 indexed targetTraitId,
        bytes32 variantCommitment,
        uint256 rewardPaid
    );

    /**
     * @notice Emitted when an expired, completed, or cancelled bounty is closed and refunded.
     * @param bountyId Closed bounty identifier.
     * @param sponsor Sponsor address receiving unused funding.
     * @param refundedAmount Refunded $GENO wei amount.
     */
    event ZkBountyClosed(uint256 indexed bountyId, address indexed sponsor, uint256 indexed refundedAmount);
}