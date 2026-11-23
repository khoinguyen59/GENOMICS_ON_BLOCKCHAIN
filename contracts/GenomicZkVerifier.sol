// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { GenomicZkBountyStorage } from "./zk/GenomicZkBountyStorage.sol";

/**
 * @title GenomicZkVerifier
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Zero-Knowledge Genomic Variant Verification & Bounty Protocol (zk-Genomics).
 *         Enables biomedical researchers to fund targeted genotype bounties and allows donors
 *         to prove possession of specific genetic variants (e.g., ALDH2 rs671, BRCA1, EDAR, ACTN3)
 *         WITHOUT revealing their full 3-billion-basepair raw sequence, preserving complete privacy
 *         under GDPR Article 5 (Data Minimization) & Article 9 (Special Category Genetic Data).
 * @dev Eliminates the "Download-and-Decrypt" privacy gap via BN254 Groth16 pairing verification
 *      (EVM precompiles 0x06, 0x07, 0x08) with optional sequencing-lab ECDSA attestations.
 */
contract GenomicZkVerifier is GenomicZkBountyStorage, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Immutable ERC-20 payment token ($GENO) used to fund and disburse ZK bounties.
    IERC20 private immutable PAYMENT_TOKEN;

    uint256 internal constant R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant B2_RE = 0x2b149d40ceb8aaae81be18991be06ac3b5b4c5e559dbefa33267e6dc24a138e5;
    uint256 internal constant B2_IM = 0x009713b03af0fed4cd2cafadeed8fdf4a74fa084e52d1852e4a2bd0685c315d2;

    /// @notice Groth16 verification key G1 point alpha.
    G1Point public alpha;
    /// @notice Groth16 verification key G2 point beta.
    G2Point public beta;
    /// @notice Groth16 verification key G2 point gamma.
    G2Point public gamma;
    /// @notice Groth16 verification key G2 point delta.
    G2Point public delta;
    /// @notice Groth16 verification key G1 constant IC[0].
    G1Point public ic0;
    /// @notice Groth16 verification key G1 public input coefficient IC[1].
    G1Point public ic1;
    /// @notice Groth16 verification key G1 public input coefficient IC[2] (V2 3-input mode).
    G1Point public ic2;
    /// @notice Groth16 verification key G1 public input coefficient IC[3] (V2 3-input mode).
    G1Point public ic3;
    /// @notice Monotonic verification key ceremony epoch counter.
    uint256 public vkEpoch;

    /// @notice Thrown when the constructor payment token address is zero.
    error InvalidPaymentToken();
    /// @notice Thrown when bounty funding, duration, traitId, or requiredAttestor parameters are invalid.
    error InvalidBountyParameters();
    /// @notice Thrown when referencing a non-existent, inactive, or expired bounty.
    error BountyExpiredOrInactive();
    /// @notice Thrown when all funded claims on a bounty have been exhausted.
    error BountyFullyClaimed();
    /// @notice Thrown when the caller already claimed this bounty.
    error DonorAlreadyClaimed();
    /// @notice Thrown when a Groth16 proof or public commitment fails verification.
    error InvalidZkProof();
    /// @notice Thrown when a BN254 G1/G2 point is off-curve, out-of-field, or fails subgroup/distinctness checks.
    error InvalidCurvePoint();
    /// @notice Thrown when a caller other than the bounty sponsor or contract owner closes a bounty.
    error OnlyBountySponsor();
    /// @notice Thrown when attempting to close or prune a live non-expired bounty early.
    error BountyNotExpired();
    /// @notice Thrown when attempting to rescue escrowed paymentToken balances.
    error CannotRescuePaymentToken();
    /// @notice Thrown when a zero address is passed to an administrative setter.
    error InvalidAddress();
    /// @notice Thrown when active bounties block VK rotation or global capacity is full.
    error ActiveBountiesExist();
    /// @notice Thrown when a sponsor already holds MAX_ACTIVE_BOUNTIES_PER_SPONSOR active bounties.
    error SponsorActiveBountyLimitReached();
    /// @notice Thrown when an unattested bounty/claim is attempted under strict lab attestation policy.
    error LabAttestationRequired();
    /// @notice Thrown when a clinical lab ECDSA signature, attestor approval, or digest replay check fails.
    error InvalidLabAttestation();
    /// @notice Thrown when a clinical lab ECDSA attestation deadline has passed.
    error AttestationExpired();
    /// @notice Thrown when attempting to downgrade a V2 3-input VK back to legacy 1-input mode.
    error DowngradeNotAllowed();
    /// @notice Thrown when all 8 distinct approved-lab attestor slots for a donor/trait are already occupied.
    error AttestorSlotFull();

    /**
     * @notice Deploy GenomicZkVerifier with provably trapdoor-free NUMS BN254 default VK points.
     * @param _paymentToken Address of the $GENO ERC-20 token contract.
     */
    constructor(address _paymentToken) Ownable(msg.sender) {
        if (_paymentToken == address(0)) revert InvalidPaymentToken();
        PAYMENT_TOKEN = IERC20(_paymentToken);

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
     * @notice Return the immutable ERC-20 payment token ($GENO).
     * @return token ERC-20 payment token contract.
     */
    function paymentToken() external view returns (IERC20 token) {
        return PAYMENT_TOKEN;
    }

    /**
     * @notice Enable or disable strict production sequencing-lab attestation enforcement.
     * @param required When true, unattested createZkBounty() reverts and createAttestedZkBounty() requires an approved lab.
     */
    function setRequireLabAttestation(bool required) external onlyOwner {
        requireLabAttestation = required;
        emit LabAttestationPolicyUpdated(required);
    }

    /**
     * @notice Approve or revoke a certified clinical sequencing-lab attestor address.
     * @param lab Sequencing-lab ECDSA signer address.
     * @param approved Approval status.
     */
    function setApprovedLabAttestor(address lab, bool approved) external onlyOwner {
        if (lab == address(0)) revert InvalidAddress();
        approvedLabAttestors[lab] = approved;
        emit ApprovedLabAttestorUpdated(lab, approved);
    }

    function _removeActiveBounty(uint256 bountyId) internal {
        uint256 idx1 = _activeBountyIndex[bountyId];
        if (idx1 < 1) return;
        uint256 lastIdx = _activeBountyEntries.length - 1;
        uint256 lastEntry = _activeBountyEntries[lastIdx];
        if (idx1 - 1 != lastIdx) {
            _activeBountyEntries[idx1 - 1] = lastEntry;
            _activeBountyIndex[lastEntry & BOUNTY_ID_MASK] = idx1;
        }
        _activeBountyEntries.pop();
        delete _activeBountyIndex[bountyId];
        if (_activeBountyCount > 0) {
            unchecked {
                --_activeBountyCount;
            }
        }

        address sponsor = bounties[bountyId].sponsor;
        uint256 sIdx1 = _sponsorBountyIndex[bountyId];
        if (sIdx1 != 0) {
            uint256[] storage sList = _sponsorActiveBountyIds[sponsor];
            uint256 sLastIdx = sList.length - 1;
            uint256 sLastId = sList[sLastIdx];
            if (sIdx1 - 1 != sLastIdx) {
                sList[sIdx1 - 1] = sLastId;
                _sponsorBountyIndex[sLastId] = sIdx1;
            }
            sList.pop();
            delete _sponsorBountyIndex[bountyId];
        }
        if (sponsorActiveBounties[sponsor] > 0) {
            unchecked {
                --sponsorActiveBounties[sponsor];
            }
        }
    }

    function _pruneSponsorInactiveBounties(address sponsor) internal {
        uint256[] storage sList = _sponsorActiveBountyIds[sponsor];
        uint256 i = 0;
        while (i < sList.length) {
            uint256 id = sList[i];
            ZkBounty storage b = bounties[id];
            if (!b.isActive || b.remainingFunding == 0 || !(block.timestamp < b.expiresAt)) {
                _removeActiveBounty(id);
            } else {
                unchecked {
                    ++i;
                }
            }
        }
    }

    function _pruneExpiredBounded(uint256 maxSteps, bool stopOnFirstFree) internal returns (uint256 pruned) {
        uint256 len = _activeBountyEntries.length;
        if (len < 1 || maxSteps < 1) return 0;
        uint256 steps = maxSteps < len ? maxSteps : len;
        uint256 cursor = _pruneCursor;
        if (!(cursor < len)) cursor = 0;
        uint256 nowTs = block.timestamp;
        for (uint256 checked = 0; checked < steps && len > 0; ) {
            if (!(cursor < len)) cursor = 0;
            uint256 entry = _activeBountyEntries[cursor];
            if (!(nowTs < (entry >> 192))) {
                _removeActiveBounty(entry & BOUNTY_ID_MASK);
                len = _activeBountyEntries.length;
                unchecked {
                    ++pruned;
                }
                if (stopOnFirstFree && _activeBountyCount < MAX_ACTIVE_BOUNTIES) {
                    break;
                }
            } else {
                unchecked {
                    ++cursor;
                }
            }
            unchecked {
                ++checked;
            }
        }
        _pruneCursor = cursor < len ? cursor : 0;
    }

    /**
     * @notice Permissionless O(1) slot cleanup for an expired or inactive bounty without modifying sponsor refund balance.
     * @param bountyId Target expired or completed bounty identifier.
     */
    function pruneExpiredBounty(uint256 bountyId) external {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        ZkBounty storage b = bounties[bountyId];
        if (b.isActive && b.remainingFunding > 0 && block.timestamp < b.expiresAt) {
            revert BountyNotExpired();
        }
        _removeActiveBounty(bountyId);
    }

    /**
     * @notice Permissionless bounded batch cleanup for expired bounty slots (capped at MAX_BATCH_PRUNE_STEPS = 256).
     * @param maxIterations Maximum number of active slots to inspect in this transaction.
     * @return pruned Number of expired slots reclaimed.
     */
    function pruneExpiredBounties(uint256 maxIterations) external returns (uint256 pruned) {
        uint256 steps = maxIterations > MAX_BATCH_PRUNE_STEPS ? MAX_BATCH_PRUNE_STEPS : maxIterations;
        return _pruneExpiredBounded(steps, false);
    }

    /**
     * @notice Return current count of live, non-expired funded bounties (1-SLOAD per packed active slot).
     * @return count Number of currently active non-expired bounties.
     */
    function activeBountyCount() external view returns (uint256 count) {
        uint256 len = _activeBountyEntries.length;
        uint256 nowTs = block.timestamp;
        for (uint256 i = 0; i < len; ) {
            if (nowTs < (_activeBountyEntries[i] >> 192)) {
                unchecked {
                    ++count;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    function _sameOrNegG1(uint256[2] calldata a, uint256[2] calldata b) internal pure returns (bool) {
        return a[0] == b[0];
    }

    function _sameOrNegG2(uint256[2][2] calldata a, uint256[2][2] calldata b) internal pure returns (bool) {
        return a[0][0] == b[0][0] && a[0][1] == b[0][1];
    }

    function _validateAndStoreBaseVk(
        uint256[2] calldata alphaPt,
        uint256[2][2] calldata betaPt,
        uint256[2][2] calldata gammaPt,
        uint256[2][2] calldata deltaPt,
        uint256[2] calldata ic0Pt,
        uint256[2] calldata ic1Pt
    ) internal {
        _pruneExpiredBounded(128, false);
        if (vkEpoch > 0 && _activeBountyCount > 0) revert ActiveBountiesExist();

        if (!_isOnCurveG1(alphaPt[0], alphaPt[1]) || (alphaPt[0] == 0 && alphaPt[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG1(ic0Pt[0], ic0Pt[1]) || (ic0Pt[0] == 0 && ic0Pt[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG1(ic1Pt[0], ic1Pt[1]) || (ic1Pt[0] == 0 && ic1Pt[1] == 0)) revert InvalidCurvePoint();
        if (_sameOrNegG1(alphaPt, ic0Pt) || _sameOrNegG1(alphaPt, ic1Pt) || _sameOrNegG1(ic0Pt, ic1Pt)) {
            revert InvalidCurvePoint();
        }
        if (!_isOnCurveG2(betaPt) || (betaPt[0][0] == 0 && betaPt[0][1] == 0) || !_isInSubgroupG2(betaPt)) {
            revert InvalidCurvePoint();
        }
        if (!_isOnCurveG2(gammaPt) || (gammaPt[0][0] == 0 && gammaPt[0][1] == 0) || !_isInSubgroupG2(gammaPt)) {
            revert InvalidCurvePoint();
        }
        if (!_isOnCurveG2(deltaPt) || (deltaPt[0][0] == 0 && deltaPt[0][1] == 0) || !_isInSubgroupG2(deltaPt)) {
            revert InvalidCurvePoint();
        }
        if (_sameOrNegG2(betaPt, gammaPt) || _sameOrNegG2(betaPt, deltaPt) || _sameOrNegG2(gammaPt, deltaPt)) {
            revert InvalidCurvePoint();
        }

        alpha = G1Point(alphaPt[0], alphaPt[1]);
        beta = G2Point(betaPt[0][0], betaPt[0][1], betaPt[1][0], betaPt[1][1]);
        gamma = G2Point(gammaPt[0][0], gammaPt[0][1], gammaPt[1][0], gammaPt[1][1]);
        delta = G2Point(deltaPt[0][0], deltaPt[0][1], deltaPt[1][0], deltaPt[1][1]);
        ic0 = G1Point(ic0Pt[0], ic0Pt[1]);
        ic1 = G1Point(ic1Pt[0], ic1Pt[1]);
    }

    /**
     * @notice Configure or rotate the 1-public-input Groth16 verification key parameters (legacy ceremony setup).
     * @param _alpha Verification key G1 point alpha.
     * @param _beta Verification key G2 point beta.
     * @param _gamma Verification key G2 point gamma.
     * @param _delta Verification key G2 point delta.
     * @param _ic0 Verification key G1 point IC[0].
     * @param _ic1 Verification key G1 point IC[1].
     */
    function setupVerificationKey(
        uint256[2] calldata _alpha,
        uint256[2][2] calldata _beta,
        uint256[2][2] calldata _gamma,
        uint256[2][2] calldata _delta,
        uint256[2] calldata _ic0,
        uint256[2] calldata _ic1
    ) external onlyOwner {
        if (ic2.x != 0 || ic2.y != 0) revert DowngradeNotAllowed();
        _validateAndStoreBaseVk(_alpha, _beta, _gamma, _delta, _ic0, _ic1);
        ic2 = G1Point(0, 0);
        ic3 = G1Point(0, 0);
        unchecked {
            ++vkEpoch;
        }
        emit VerificationKeyUpdated(msg.sender);
    }

    /**
     * @notice Configure or rotate the 3-public-input Groth16 verification key (zero-slack MiMC-7 R1CS circuit).
     * @param alphaPt Verification key G1 point alpha.
     * @param betaPt Verification key G2 point beta.
     * @param gammaPt Verification key G2 point gamma.
     * @param deltaPt Verification key G2 point delta.
     * @param ic0Pt Verification key G1 point IC[0].
     * @param ic1Pt Verification key G1 point IC[1].
     * @param ic2Pt Verification key G1 point IC[2].
     * @param ic3Pt Verification key G1 point IC[3].
     */
    function setupVerificationKeyV2(
        uint256[2] calldata alphaPt,
        uint256[2][2] calldata betaPt,
        uint256[2][2] calldata gammaPt,
        uint256[2][2] calldata deltaPt,
        uint256[2] calldata ic0Pt,
        uint256[2] calldata ic1Pt,
        uint256[2] calldata ic2Pt,
        uint256[2] calldata ic3Pt
    ) external onlyOwner {
        if (!_isOnCurveG1(ic2Pt[0], ic2Pt[1]) || (ic2Pt[0] == 0 && ic2Pt[1] == 0)) revert InvalidCurvePoint();
        if (!_isOnCurveG1(ic3Pt[0], ic3Pt[1]) || (ic3Pt[0] == 0 && ic3Pt[1] == 0)) revert InvalidCurvePoint();
        if (
            _sameOrNegG1(ic2Pt, alphaPt) ||
            _sameOrNegG1(ic2Pt, ic0Pt) ||
            _sameOrNegG1(ic2Pt, ic1Pt) ||
            _sameOrNegG1(ic2Pt, ic3Pt) ||
            _sameOrNegG1(ic3Pt, alphaPt) ||
            _sameOrNegG1(ic3Pt, ic0Pt) ||
            _sameOrNegG1(ic3Pt, ic1Pt)
        ) {
            revert InvalidCurvePoint();
        }
        _validateAndStoreBaseVk(alphaPt, betaPt, gammaPt, deltaPt, ic0Pt, ic1Pt);
        ic2 = G1Point(ic2Pt[0], ic2Pt[1]);
        ic3 = G1Point(ic3Pt[0], ic3Pt[1]);
        unchecked {
            ++vkEpoch;
        }
        emit VerificationKeyUpdated(msg.sender);
    }

    function _validateBountyQuota(
        bytes32 targetTraitId,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 durationSeconds
    ) internal {
        if (
            targetTraitId == bytes32(0) ||
            rewardPerClaim < MIN_BOUNTY_REWARD ||
            maxClaims == 0 ||
            durationSeconds < MIN_BOUNTY_DURATION ||
            durationSeconds > MAX_BOUNTY_DURATION
        ) {
            revert InvalidBountyParameters();
        }
        _pruneSponsorInactiveBounties(msg.sender);
        if (!(_activeBountyCount < MAX_ACTIVE_BOUNTIES)) {
            _pruneExpiredBounded(32, true);
        }
        if (!(_activeBountyCount < MAX_ACTIVE_BOUNTIES)) revert ActiveBountiesExist();
        if (!(sponsorActiveBounties[msg.sender] < MAX_ACTIVE_BOUNTIES_PER_SPONSOR)) {
            revert SponsorActiveBountyLimitReached();
        }
    }

    function _createZkBountyInternal(
        bytes32 targetTraitId,
        string calldata traitDescription,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 durationSeconds,
        address requiredAttestor
    ) internal returns (uint256 newBountyId) {
        _validateBountyQuota(targetTraitId, rewardPerClaim, maxClaims, durationSeconds);

        uint256 totalRequiredFunding = rewardPerClaim * maxClaims;
        newBountyId = ++bountyCount;
        uint256 expiresAt = block.timestamp + durationSeconds;

        bounties[newBountyId] = ZkBounty({
            bountyId: newBountyId,
            sponsor: msg.sender,
            isActive: true,
            targetTraitId: targetTraitId,
            traitDescription: traitDescription,
            rewardPerClaim: rewardPerClaim,
            maxClaims: maxClaims,
            currentClaims: 0,
            totalFunding: totalRequiredFunding,
            remainingFunding: totalRequiredFunding,
            expiresAt: expiresAt
        });
        if (requiredAttestor != address(0)) bountyRequiredAttestor[newBountyId] = requiredAttestor;
        _activeBountyEntries.push((expiresAt << 192) | newBountyId);
        _activeBountyIndex[newBountyId] = _activeBountyEntries.length;
        _sponsorActiveBountyIds[msg.sender].push(newBountyId);
        _sponsorBountyIndex[newBountyId] = _sponsorActiveBountyIds[msg.sender].length;
        unchecked {
            ++_activeBountyCount;
            ++sponsorActiveBounties[msg.sender];
        }

        PAYMENT_TOKEN.safeTransferFrom(msg.sender, address(this), totalRequiredFunding);
        emit ZkBountyCreated(
            newBountyId,
            msg.sender,
            targetTraitId,
            traitDescription,
            rewardPerClaim,
            maxClaims,
            totalRequiredFunding,
            expiresAt
        );
        if (requiredAttestor != address(0)) emit AttestedZkBountyCreated(newBountyId, requiredAttestor);
    }

    /**
     * @notice Create a new zero-knowledge genetic trait bounty funded in $GENO tokens.
     * @param targetTraitId Canonical hash of the genomic variant (e.g. keccak256("ALDH2_rs671")).
     * @param traitDescription Description of phenotype (e.g. "Aldehyde Dehydrogenase 2 Deficiency rs671(A)").
     * @param rewardPerClaim Reward per verified donor in $GENO wei.
     * @param maxClaims Maximum number of donors in the research cohort.
     * @param durationSeconds Active duration of the bounty program.
     * @return bountyId Newly created bounty identifier.
     */
    function createZkBounty(
        bytes32 targetTraitId,
        string calldata traitDescription,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 durationSeconds
    ) external nonReentrant returns (uint256 bountyId) {
        if (requireLabAttestation) revert LabAttestationRequired();
        return _createZkBountyInternal(
            targetTraitId,
            traitDescription,
            rewardPerClaim,
            maxClaims,
            durationSeconds,
            address(0)
        );
    }

    /**
     * @notice Create a sequencing-lab attested ZK bounty that requires an off-chain ECDSA lab
     *         attestation over each donor's variantCommitment in addition to the Groth16 proof,
     *         defending against unattested Sybil self-commit bounty draining.
     * @param targetTraitId Canonical hash of the genomic variant.
     * @param traitDescription Description of phenotype.
     * @param rewardPerClaim Reward per verified donor in $GENO wei.
     * @param maxClaims Maximum number of donors in the research cohort.
     * @param durationSeconds Active duration of the bounty program.
     * @param requiredAttestor Trusted sequencing-lab ECDSA signer address (must be non-zero).
     * @return bountyId Newly created bounty identifier.
     */
    function createAttestedZkBounty(
        bytes32 targetTraitId,
        string calldata traitDescription,
        uint256 rewardPerClaim,
        uint256 maxClaims,
        uint256 durationSeconds,
        address requiredAttestor
    ) external nonReentrant returns (uint256 bountyId) {
        if (requiredAttestor == address(0)) revert InvalidBountyParameters();
        if (requireLabAttestation && !approvedLabAttestors[requiredAttestor]) {
            revert InvalidLabAttestation();
        }
        return _createZkBountyInternal(
            targetTraitId,
            traitDescription,
            rewardPerClaim,
            maxClaims,
            durationSeconds,
            requiredAttestor
        );
    }

    /**
     * @notice Submit a Zero-Knowledge Proof of Genetic Variant possession and claim reward (unattested bounties).
     * @param bountyId Target bounty identifier.
     * @param proof Groth16 cryptographic proof (points A, B, C).
     * @param variantCommitment Cryptographic commitment to the donor's private genomic witness (MiMC-7 output).
     */
    function claimZkBounty(
        uint256 bountyId,
        ZkProof calldata proof,
        bytes32 variantCommitment
    ) external nonReentrant {
        if (requireLabAttestation) revert LabAttestationRequired();
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        if (bountyRequiredAttestor[bountyId] != address(0)) revert LabAttestationRequired();
        _claimZkBountyInternal(bountyId, proof.a, proof.b, proof.c, variantCommitment, bytes32(0));
    }

    /**
     * @notice Submit a sequencing-lab ECDSA attestation alongside a Groth16 proof to claim an attested ZK bounty.
     * @param bountyId Target attested bounty identifier.
     * @param a Groth16 G1 point A.
     * @param b Groth16 G2 point B.
     * @param c Groth16 G1 point C.
     * @param variantCommitment Donor's MiMC-7 variant commitment attested by requiredAttestor.
     * @param attestationDeadline Unix timestamp after which the lab attestation expires.
     * @param labSignature 65-byte ECDSA signature from bountyRequiredAttestor[bountyId].
     */
    function claimAttestedZkBounty(
        uint256 bountyId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 variantCommitment,
        uint256 attestationDeadline,
        bytes calldata labSignature
    ) external nonReentrant {
        address requiredAttestor = _requireValidAttestorContext(bountyId, attestationDeadline);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "GENOCHAIN_LAB_ATTESTATION_V1",
                    block.chainid,
                    address(this),
                    bountyId,
                    bounties[bountyId].targetTraitId,
                    msg.sender,
                    variantCommitment,
                    attestationDeadline
                )
            )
        );
        _verifyAndConsumeAttestation(digest, labSignature, requiredAttestor);
        _claimZkBountyInternal(bountyId, a, b, c, variantCommitment, bytes32(0));
    }

    /**
     * @notice Submit a dataset-bound sequencing-lab ECDSA attestation alongside a Groth16 proof,
     *         cryptographically binding the proven genomic trait to a specific encrypted dataset rawDataHash.
     * @param bountyId Target attested bounty identifier.
     * @param a Groth16 G1 point A.
     * @param b Groth16 G2 point B.
     * @param c Groth16 G1 point C.
     * @param variantCommitment Donor's MiMC-7 variant commitment attested by requiredAttestor.
     * @param rawDataHash Non-zero SHA-256 hash of the encrypted dataset package bound by the sequencing lab.
     * @param attestationDeadline Unix timestamp after which the lab attestation expires.
     * @param labSignature 65-byte ECDSA signature from bountyRequiredAttestor[bountyId].
     */
    function claimDatasetAttestedZkBounty(
        uint256 bountyId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 variantCommitment,
        bytes32 rawDataHash,
        uint256 attestationDeadline,
        bytes calldata labSignature
    ) external nonReentrant {
        if (rawDataHash == bytes32(0)) revert InvalidLabAttestation();
        address requiredAttestor = _requireValidAttestorContext(bountyId, attestationDeadline);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    string.concat("GENOCHAIN_LAB_DATASET_", "ATTESTATION_V1"),
                    block.chainid,
                    address(this),
                    bountyId,
                    bounties[bountyId].targetTraitId,
                    msg.sender,
                    variantCommitment,
                    rawDataHash,
                    attestationDeadline
                )
            )
        );
        _verifyAndConsumeAttestation(digest, labSignature, requiredAttestor);
        _claimZkBountyInternal(bountyId, a, b, c, variantCommitment, rawDataHash);
    }

    function _requireValidAttestorContext(
        uint256 bountyId,
        uint256 attestationDeadline
    ) internal view returns (address requiredAttestor) {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        requiredAttestor = bountyRequiredAttestor[bountyId];
        if (requiredAttestor == address(0)) revert InvalidLabAttestation();
        if (requireLabAttestation && !approvedLabAttestors[requiredAttestor]) revert InvalidLabAttestation();
        if (block.timestamp > attestationDeadline) revert AttestationExpired();
    }

    function _verifyAndConsumeAttestation(
        bytes32 digest,
        bytes calldata labSignature,
        address requiredAttestor
    ) internal {
        if (usedLabAttestationDigests[digest]) revert InvalidLabAttestation();
        (address recovered, ECDSA.RecoverError err, bytes32 errArg) = ECDSA.tryRecoverCalldata(digest, labSignature);
        if (err != ECDSA.RecoverError.NoError || errArg != bytes32(0) || recovered != requiredAttestor) {
            revert InvalidLabAttestation();
        }
        usedLabAttestationDigests[digest] = true;
    }

    function _verifyClaimProof(
        uint256 bountyId,
        bytes32 targetTraitId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 variantCommitment
    ) internal view {
        if (!validateCurvePoints(a, b, c)) revert InvalidCurvePoint();
        if (ic2.x != 0 || ic2.y != 0) {
            uint256 pub0 = uint256(variantCommitment);
            if (!(pub0 < R_MOD)) revert InvalidZkProof();
            uint256 pub1 = uint256(keccak256(abi.encodePacked(targetTraitId, msg.sender))) % R_MOD;
            uint256 pub2 = uint256(
                keccak256(
                    abi.encodePacked(targetTraitId, msg.sender, bountyId, address(this), block.chainid, vkEpoch)
                )
            ) % R_MOD;
            if (!verifyProofInternal3(a, b, c, pub0, pub1, pub2)) revert InvalidZkProof();
        } else {
            uint256 publicSignalBound = uint256(
                keccak256(
                    abi.encodePacked(
                        variantCommitment,
                        targetTraitId,
                        msg.sender,
                        bountyId,
                        address(this),
                        block.chainid,
                        vkEpoch
                    )
                )
            ) % R_MOD;
            if (!verifyProofInternal(a, b, c, publicSignalBound)) revert InvalidZkProof();
        }
    }

    function _claimZkBountyInternal(
        uint256 bountyId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 variantCommitment,
        bytes32 rawDataHash
    ) internal {
        ZkBounty storage bounty = bounties[bountyId];
        if (!bounty.isActive || !(block.timestamp < bounty.expiresAt)) revert BountyExpiredOrInactive();
        if (!(bounty.currentClaims < bounty.maxClaims)) revert BountyFullyClaimed();
        if (hasClaimedBounty[bountyId][msg.sender]) revert DonorAlreadyClaimed();
        if (variantCommitment == bytes32(0)) revert InvalidZkProof();

        _verifyClaimProof(bountyId, bounty.targetTraitId, a, b, c, variantCommitment);

        hasClaimedBounty[bountyId][msg.sender] = true;
        address reqAttestor = bountyRequiredAttestor[bountyId];
        address attestorSlot = reqAttestor != address(0) ? reqAttestor : UNATTESTED_ATTESTOR;
        _addSlotAttestor(_variantSlotKey(variantCommitment), msg.sender, attestorSlot);
        _addSlotAttestor(_traitVariantSlotKey(bounty.targetTraitId, variantCommitment), msg.sender, attestorSlot);
        if (rawDataHash != bytes32(0)) {
            _addSlotAttestor(_datasetTraitSlotKey(rawDataHash, bounty.targetTraitId), msg.sender, attestorSlot);
        }
        ++bounty.currentClaims;
        bounty.remainingFunding -= bounty.rewardPerClaim;

        if (bounty.currentClaims == bounty.maxClaims) {
            bounty.isActive = false;
            _removeActiveBounty(bountyId);
        }

        PAYMENT_TOKEN.safeTransfer(msg.sender, bounty.rewardPerClaim);
        emit ZkProofVerified(bountyId, msg.sender, bounty.targetTraitId, variantCommitment, bounty.rewardPerClaim);
        if (rawDataHash != bytes32(0)) {
            emit DatasetTraitAttested(bountyId, msg.sender, bounty.targetTraitId, rawDataHash, variantCommitment);
        }
    }

    /**
     * @notice Close an expired or completed bounty and refund unused tokens to the sponsor.
     * @param bountyId Target bounty identifier.
     */
    function closeExpiredBounty(uint256 bountyId) external nonReentrant {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        ZkBounty storage bounty = bounties[bountyId];

        if (msg.sender != bounty.sponsor && msg.sender != owner()) revert OnlyBountySponsor();
        address reqAttestor = bountyRequiredAttestor[bountyId];
        bool attestorRevoked = requireLabAttestation && (reqAttestor == address(0) || !approvedLabAttestors[reqAttestor]);
        if (!attestorRevoked && block.timestamp < bounty.expiresAt && bounty.currentClaims < bounty.maxClaims) {
            revert BountyNotExpired();
        }
        if (!bounty.isActive && bounty.remainingFunding == 0) {
            _removeActiveBounty(bountyId);
            return;
        }

        uint256 refundAmount = bounty.remainingFunding;
        bounty.isActive = false;
        bounty.remainingFunding = 0;
        _removeActiveBounty(bountyId);

        if (refundAmount > 0) PAYMENT_TOKEN.safeTransfer(bounty.sponsor, refundAmount);
        emit ZkBountyClosed(bountyId, bounty.sponsor, refundAmount);
    }

    /**
     * @notice Emergency owner cancellation of an active bounty with 100% remaining-funding refund
     *         to the sponsor, allowing governance to unblock verifier upgrades or VK rotations.
     * @param bountyId Target bounty identifier.
     */
    function emergencyCancelBounty(uint256 bountyId) external onlyOwner nonReentrant {
        if (bountyId == 0 || bountyId > bountyCount) revert BountyExpiredOrInactive();
        ZkBounty storage bounty = bounties[bountyId];

        if (!bounty.isActive && bounty.remainingFunding == 0) {
            _removeActiveBounty(bountyId);
            return;
        }

        uint256 refundAmount = bounty.remainingFunding;
        bounty.isActive = false;
        bounty.remainingFunding = 0;
        _removeActiveBounty(bountyId);

        if (refundAmount > 0) PAYMENT_TOKEN.safeTransfer(bounty.sponsor, refundAmount);
        emit ZkBountyClosed(bountyId, bounty.sponsor, refundAmount);
    }

    function _variantSlotKey(bytes32 variantCommitment) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(1), variantCommitment));
    }

    function _traitVariantSlotKey(bytes32 targetTraitId, bytes32 variantCommitment) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(2), targetTraitId, variantCommitment));
    }

    function _datasetTraitSlotKey(bytes32 rawDataHash, bytes32 traitId) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(3), rawDataHash, traitId));
    }

    function _hasValidSlotAttestor(bytes32 slotKey, address donor) internal view returns (bool) {
        address[] storage list = _slotAttestors[vkEpoch][slotKey][donor];
        uint256 len = list.length;
        if (len == 0) return false;
        if (!requireLabAttestation) return true;
        for (uint256 i = 0; i < len; ) {
            address att = list[i];
            if (att != UNATTESTED_ATTESTOR && approvedLabAttestors[att]) return true;
            unchecked {
                ++i;
            }
        }
        return false;
    }

    function _addSlotAttestor(bytes32 slotKey, address donor, address incoming) internal {
        uint256 epoch = vkEpoch;
        uint256 len = _slotAttestors[epoch][slotKey][donor].length;
        uint256 replaceIdx = type(uint256).max;
        for (uint256 i = 0; i < len; ) {
            address existing = _slotAttestors[epoch][slotKey][donor][i];
            if (existing == incoming) return;
            if (
                replaceIdx == type(uint256).max &&
                (existing == UNATTESTED_ATTESTOR || !approvedLabAttestors[existing])
            ) {
                replaceIdx = i;
            }
            unchecked {
                ++i;
            }
        }
        if (len < MAX_ATTESTORS_PER_SLOT) {
            _slotAttestors[epoch][slotKey][donor].push(incoming);
        } else if (replaceIdx != type(uint256).max && incoming != UNATTESTED_ATTESTOR) {
            _slotAttestors[epoch][slotKey][donor][replaceIdx] = incoming;
        } else if (incoming != UNATTESTED_ATTESTOR) {
            revert AttestorSlotFull();
        }
    }

    /**
     * @notice Backward-compatible getter strictly scoped to current verification key epoch & active attestor policy.
     * @param variantCommitment MiMC-7 variant commitment.
     * @param donor Donor wallet address.
     * @return verified True if verified in the current VK epoch.
     */
    function verifiedCommitments(bytes32 variantCommitment, address donor) external view returns (bool verified) {
        return _hasValidSlotAttestor(_variantSlotKey(variantCommitment), donor);
    }

    /**
     * @notice Check whether an address has proven possession of a genomic trait under a given commitment in current epoch.
     * @param variantCommitment MiMC-7 variant commitment.
     * @param donor Donor wallet address.
     * @return verified True if verified in the current VK epoch.
     */
    function hasVerifiedVariant(bytes32 variantCommitment, address donor) external view returns (bool verified) {
        return _hasValidSlotAttestor(_variantSlotKey(variantCommitment), donor);
    }

    /**
     * @notice Check whether an address has proven possession of a specific trait under a given commitment in current epoch.
     * @param targetTraitId Canonical identifier of the targeted genetic trait.
     * @param variantCommitment MiMC-7 variant commitment.
     * @param donor Donor wallet address.
     * @return verified True if verified in the current VK epoch.
     */
    function hasVerifiedTraitVariant(
        bytes32 targetTraitId,
        bytes32 variantCommitment,
        address donor
    ) external view returns (bool verified) {
        return _hasValidSlotAttestor(_traitVariantSlotKey(targetTraitId, variantCommitment), donor);
    }

    /**
     * @notice Check whether a donor has proven possession of a trait cryptographically bound to a specific encrypted dataset hash.
     * @param rawDataHash SHA-256 hash of encrypted dataset package.
     * @param traitId Canonical identifier of the targeted genetic trait.
     * @param donor Donor wallet address.
     * @return verified True if verified in the current VK epoch.
     */
    function hasVerifiedDatasetTrait(
        bytes32 rawDataHash,
        bytes32 traitId,
        address donor
    ) external view returns (bool verified) {
        if (rawDataHash == bytes32(0)) return false;
        return _hasValidSlotAttestor(_datasetTraitSlotKey(rawDataHash, traitId), donor);
    }

    /**
     * @notice Rescue mistakenly sent ERC-20 tokens to the verifier contract.
     *         Cannot rescue paymentToken to prevent draining bounty funding.
     * @param tokenAddress The ERC-20 token address to rescue.
     * @param to The recipient address.
     * @param amount The token amount in wei.
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner nonReentrant {
        if (tokenAddress == address(0) || to == address(0)) revert InvalidAddress();
        if (tokenAddress == address(PAYMENT_TOKEN)) revert CannotRescuePaymentToken();
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokensRescued(tokenAddress, to, amount);
    }

    function validateCurvePoints(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal pure returns (bool) {
        if (!(a[0] < P_MOD) || !(a[1] < P_MOD)) return false;
        if (!(b[0][0] < P_MOD) || !(b[0][1] < P_MOD)) return false;
        if (!(b[1][0] < P_MOD) || !(b[1][1] < P_MOD)) return false;
        if (!(c[0] < P_MOD) || !(c[1] < P_MOD)) return false;
        if (!_isOnCurveG1(a[0], a[1])) return false;
        if (!_isOnCurveG1(c[0], c[1])) return false;
        if (!_isOnCurveG2(b)) return false;
        return true;
    }

    function _isOnCurveG1(uint256 x, uint256 y) internal pure returns (bool) {
        if (x == 0 && y == 0) return true;
        if (!(x < P_MOD) || !(y < P_MOD)) return false;
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
        if (!(xIm < P_MOD) || !(xRe < P_MOD) || !(yIm < P_MOD) || !(yRe < P_MOD)) return false;

        uint256 y2Re = addmod(mulmod(yRe, yRe, P_MOD), P_MOD - mulmod(yIm, yIm, P_MOD), P_MOD);
        uint256 y2Im = mulmod(2, mulmod(yRe, yIm, P_MOD), P_MOD);

        uint256 x2Re = addmod(mulmod(xRe, xRe, P_MOD), P_MOD - mulmod(xIm, xIm, P_MOD), P_MOD);
        uint256 x2Im = mulmod(2, mulmod(xRe, xIm, P_MOD), P_MOD);

        uint256 x3Re = addmod(mulmod(x2Re, xRe, P_MOD), P_MOD - mulmod(x2Im, xIm, P_MOD), P_MOD);
        uint256 x3Im = addmod(mulmod(x2Re, xIm, P_MOD), mulmod(x2Im, xRe, P_MOD), P_MOD);

        uint256 rhsRe = addmod(x3Re, B2_RE, P_MOD);
        uint256 rhsIm = addmod(x3Im, B2_IM, P_MOD);

        return (y2Re == rhsRe) && (y2Im == rhsIm);
    }

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
            success := staticcall(sub(gas(), 2000), 0x08, input, 384, out, 32)
        }
        return success && (out[0] == 1);
    }

    function _ecMulAdd(
        uint256[2] memory acc,
        uint256 px,
        uint256 py,
        uint256 scalar
    ) internal view returns (bool ok) {
        uint256[2] memory scaled;
        bool mulOk;
        bool addOk;
        assembly {
            let buf := mload(0x40)
            mstore(0x40, add(buf, 0x80))
            mstore(buf, px)
            mstore(add(buf, 0x20), py)
            mstore(add(buf, 0x40), scalar)
            mulOk := staticcall(sub(gas(), 2000), 0x07, buf, 0x60, scaled, 0x40)

            mstore(buf, mload(acc))
            mstore(add(buf, 0x20), mload(add(acc, 0x20)))
            mstore(add(buf, 0x40), mload(scaled))
            mstore(add(buf, 0x60), mload(add(scaled, 0x20)))
            addOk := staticcall(sub(gas(), 2000), 0x06, buf, 0x80, acc, 0x40)
        }
        return mulOk && addOk;
    }

    function _checkNonTrivialProofAndVk(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal view returns (bool) {
        if (
            (a[0] == 0 && a[1] == 0) ||
            (c[0] == 0 && c[1] == 0) ||
            (b[0][0] == 0 && b[0][1] == 0 && b[1][0] == 0 && b[1][1] == 0)
        ) {
            return false;
        }
        if ((alpha.x == 0 && alpha.y == 0) || (ic1.x == 0 && ic1.y == 0)) return false;
        return true;
    }

    function verifyProofInternal(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 publicSignal
    ) internal view returns (bool) {
        if (!_checkNonTrivialProofAndVk(a, b, c)) return false;
        uint256[2] memory vkX = [ic0.x, ic0.y];
        if (!_ecMulAdd(vkX, ic1.x, ic1.y, publicSignal)) return false;
        return _verifyPairing(a, b, c, vkX);
    }

    function verifyProofInternal3(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 pub0,
        uint256 pub1,
        uint256 pub2
    ) internal view returns (bool) {
        if (!_checkNonTrivialProofAndVk(a, b, c)) return false;
        if ((ic2.x == 0 && ic2.y == 0) || (ic3.x == 0 && ic3.y == 0)) return false;
        uint256[2] memory vkX = [ic0.x, ic0.y];
        if (!_ecMulAdd(vkX, ic1.x, ic1.y, pub0)) return false;
        if (!_ecMulAdd(vkX, ic2.x, ic2.y, pub1)) return false;
        if (!_ecMulAdd(vkX, ic3.x, ic3.y, pub2)) return false;
        return _verifyPairing(a, b, c, vkX);
    }

    function _populateVkPairs(bytes memory input, uint256[2] memory vkX, uint256 cx, uint256 cy) internal view {
        assembly {
            mstore(add(input, 224), sload(alpha.slot))
            mstore(add(input, 256), sload(add(alpha.slot, 1)))
            mstore(add(input, 288), sload(beta.slot))
            mstore(add(input, 320), sload(add(beta.slot, 1)))
            mstore(add(input, 352), sload(add(beta.slot, 2)))
            mstore(add(input, 384), sload(add(beta.slot, 3)))

            mstore(add(input, 416), mload(vkX))
            mstore(add(input, 448), mload(add(vkX, 0x20)))
            mstore(add(input, 480), sload(gamma.slot))
            mstore(add(input, 512), sload(add(gamma.slot, 1)))
            mstore(add(input, 544), sload(add(gamma.slot, 2)))
            mstore(add(input, 576), sload(add(gamma.slot, 3)))

            mstore(add(input, 608), cx)
            mstore(add(input, 640), cy)
            mstore(add(input, 672), sload(delta.slot))
            mstore(add(input, 704), sload(add(delta.slot, 1)))
            mstore(add(input, 736), sload(add(delta.slot, 2)))
            mstore(add(input, 768), sload(add(delta.slot, 3)))
        }
    }

    function _verifyPairing(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[2] memory vkX
    ) internal view returns (bool) {
        bytes memory input = new bytes(768);
        uint256 negA1 = P_MOD - (a[1] % P_MOD);
        uint256 ax = a[0];
        uint256 b00 = b[0][0];
        uint256 b01 = b[0][1];
        uint256 b10 = b[1][0];
        uint256 b11 = b[1][1];
        assembly {
            mstore(add(input, 32), ax)
            mstore(add(input, 64), negA1)
            mstore(add(input, 96), b00)
            mstore(add(input, 128), b01)
            mstore(add(input, 160), b10)
            mstore(add(input, 192), b11)
        }
        _populateVkPairs(input, vkX, c[0], c[1]);

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 0x08, add(input, 32), 768, out, 32)
        }
        return success && (out[0] == 1);
    }
}