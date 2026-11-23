// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { IGenomicTokenFaucet } from "./interfaces/IGenomicTokenFaucet.sol";

/**
 * @title GenomicToken ($GENO)
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice ERC-20 utility and payment token for the Genomics on Blockchain ecosystem.
 * @dev Used for Escrow payment, access purchases, and distributing automatic royalties.
 *      Supports both an open local/testnet demo faucet (1-hour bidirectional cooldown,
 *      EIP-1153 single-tx anti-batch lock, hourly epoch cap, lifetime cap) and a
 *      production voucher-gated faucet mode (signed off-chain ECDSA vouchers with
 *      ERC-4337/EIP-7702 smart-account support) plus an owner shutdown switch.
 *      Inherits ERC20Burnable to enable token burning and control inflation.
 */
contract GenomicToken is ERC20, ERC20Burnable, Ownable2Step, IGenomicTokenFaucet {
    /// @notice Initial supply minted to the initial governance owner (10 million $GENO).
    uint256 public constant INITIAL_SUPPLY = 10_000_000 * 10 ** 18;
    /// @notice Absolute hard cap on total $GENO supply (100 million $GENO).
    uint256 public constant MAX_TOTAL_SUPPLY = 100_000_000 * 10 ** 18;
    /// @notice Lifetime maximum cumulative $GENO mintable via the faucet (50 million $GENO).
    uint256 public constant MAX_FAUCET_SUPPLY = 50_000_000 * 10 ** 18;
    /// @notice Fixed amount dispensed per faucet claim (1,000 $GENO).
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 18;
    /// @notice Bidirectional rate-limit cooldown between consecutive faucet claims (1 hour).
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    /// @notice Rolling global faucet epoch window duration (1 hour).
    uint256 public constant FAUCET_EPOCH_DURATION = 1 hours;
    /// @notice Maximum global $GENO dispensed per hourly epoch (50,000 $GENO = 50 claims/hour).
    uint256 public constant MAX_FAUCET_PER_EPOCH = 50_000 * 10 ** 18;
    bytes32 internal constant FAUCET_TX_LOCK_SLOT = keccak256("genochain.faucet.eip1153.tx_lock");

    /// @notice Cumulative $GENO minted via faucet calls across all epochs.
    uint256 public faucetMinted;
    /// @notice Timestamp marking the start of the active global faucet epoch.
    uint256 public faucetEpochStart;
    /// @notice Cumulative $GENO minted during the current hourly faucet epoch.
    uint256 public faucetEpochMinted;
    /// @notice Global faucet operational switch (owner-configurable).
    bool public faucetEnabled = true;
    /// @notice When true, open EOA faucet() is disabled and signed ECDSA vouchers are required.
    bool public faucetVoucherRequired = false;
    /// @notice Trusted ECDSA signer issuing off-chain faucet vouchers.
    address public faucetSigner;
    /// @notice Account address to timestamp of last faucet claim (caller or recipient).
    mapping(address => uint256) public lastFaucetTime;
    /// @notice Single-use nonce replay registry for voucher-gated faucet claims.
    mapping(uint256 => bool) public usedFaucetNonces;

    /**
     * @notice Emitted whenever faucet tokens are dispensed to a recipient.
     * @param receiver Recipient address receiving faucet tokens.
     * @param amount Token amount dispensed in wei.
     * @param timestamp Block timestamp of the claim.
     */
    event FaucetUsed(address indexed receiver, uint256 indexed amount, uint256 indexed timestamp);

    /**
     * @notice Emitted when governance updates faucet mode, shutdown switch, or voucher signer.
     * @param enabled Global faucet enable/disable state.
     * @param voucherRequired True if ECDSA vouchers are mandatory.
     * @param signer Configured voucher ECDSA signer address.
     */
    event FaucetConfigUpdated(bool indexed enabled, bool indexed voucherRequired, address indexed signer);

    /// @notice Thrown when a zero address is supplied for a recipient or required signer.
    error InvalidRecipient();
    /// @notice Thrown when caller or recipient is still inside the 1-hour faucet cooldown.
    /// @param remainingSeconds Seconds remaining until next eligible claim.
    error FaucetCooldownActive(uint256 remainingSeconds);
    /// @notice Thrown when a contract caller or same-tx batch factory invokes the open faucet.
    error ContractCallersNotAllowed();
    /// @notice Thrown when cumulative faucet minting would exceed MAX_FAUCET_SUPPLY.
    error FaucetMaxSupplyExceeded();
    /// @notice Thrown when current hourly epoch faucet minting would exceed MAX_FAUCET_PER_EPOCH.
    error FaucetEpochCapExceeded();
    /// @notice Thrown when the faucet is globally disabled by governance.
    error FaucetDisabled();
    /// @notice Thrown when open faucet() is called while voucher-only production mode is active.
    error FaucetVoucherRequired();
    /// @notice Thrown when a voucher ECDSA signature or configured signer is invalid.
    error InvalidFaucetVoucher();
    /// @notice Thrown when a faucet voucher's deadline timestamp has passed.
    error FaucetVoucherExpired();
    /// @notice Thrown when a faucet voucher nonce has already been redeemed.
    error FaucetVoucherUsed();
    /// @notice Thrown when minting would breach the 100M $GENO MAX_TOTAL_SUPPLY cap.
    error MaxSupplyExceeded();

    /**
     * @notice Deploy GenomicToken ($GENO) and mint INITIAL_SUPPLY to `initialOwner`.
     * @param initialOwner Governance owner receiving initial token supply.
     */
    constructor(address initialOwner) ERC20("Genomic Token", "GENO") Ownable(initialOwner) {
        faucetEpochStart = block.timestamp;
        _mint(initialOwner, INITIAL_SUPPLY);
    }

    /**
     * @notice Mint function restricted to contract owner, bounded by MAX_TOTAL_SUPPLY.
     * @param to Recipient address.
     * @param amount Token amount in wei.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (amount > MAX_TOTAL_SUPPLY - totalSupply()) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    /**
     * @notice Configure faucet operational mode (shutdown switch, production ECDSA voucher gate, and signer).
     *         In open local/testnet demo mode (default: enabled=true, voucherRequired=false), EOAs may claim
     *         directly via faucet(to). In production/public-testnet mode (voucherRequired=true), unvouchered
     *         faucet(to) reverts and recipients (including ERC-4337/EIP-7702 smart accounts) claim via
     *         claimFaucetWithVoucher() using an off-chain signed voucher.
     * @param enabled Global faucet enable/disable switch.
     * @param voucherRequired When true, disables open faucet(to) and requires signed vouchers.
     * @param signer Trusted ECDSA signer issuing off-chain faucet vouchers (required when voucherRequired=true).
     */
    function setFaucetConfig(bool enabled, bool voucherRequired, address signer) external onlyOwner {
        if (voucherRequired && signer == address(0)) revert InvalidRecipient();
        faucetEnabled = enabled;
        faucetVoucherRequired = voucherRequired;
        faucetSigner = signer;
        emit FaucetConfigUpdated(enabled, voucherRequired, signer);
    }

    function _consumeFaucetBudget() internal {
        if (FAUCET_AMOUNT > MAX_TOTAL_SUPPLY - totalSupply()) {
            revert MaxSupplyExceeded();
        }
        if (faucetMinted + FAUCET_AMOUNT > MAX_FAUCET_SUPPLY) {
            revert FaucetMaxSupplyExceeded();
        }
        if (!(block.timestamp < faucetEpochStart + FAUCET_EPOCH_DURATION)) {
            faucetEpochStart = block.timestamp;
            faucetEpochMinted = FAUCET_AMOUNT;
        } else {
            if (faucetEpochMinted + FAUCET_AMOUNT > MAX_FAUCET_PER_EPOCH) {
                revert FaucetEpochCapExceeded();
            }
            faucetEpochMinted += FAUCET_AMOUNT;
        }
        faucetMinted += FAUCET_AMOUNT;
    }

    /**
     * @notice Open local/testnet demo faucet allowing EOAs to receive test tokens.
     *         Enforces shutdown switch, optional production voucher gate, bidirectional 1-hour
     *         rate-limit on msg.sender and recipient (INVARIANT-15 Anti-Sybil), extcodesize == 0,
     *         EIP-1153 single-tx lock against constructor-factory batch draining (zero tx.origin),
     *         hourly global epoch cap (MAX_FAUCET_PER_EPOCH), and lifetime cap (MAX_FAUCET_SUPPLY).
     *         Note: On public deployments where single-constructor-per-tx Sybil or smart-account UX
     *         matters, enable setFaucetConfig(true, true, voucherSigner) and use claimFaucetWithVoucher().
     * @param to Recipient EOA of the faucet tokens.
     */
    function faucet(address to) external override {
        if (!faucetEnabled) revert FaucetDisabled();
        if (faucetVoucherRequired) revert FaucetVoucherRequired();
        if (to == address(0)) revert InvalidRecipient();
        if (msg.sender.code.length > 0 || to.code.length > 0) {
            revert ContractCallersNotAllowed();
        }
        uint256 alreadyClaimedInTx;
        bytes32 lockSlot = FAUCET_TX_LOCK_SLOT;
        assembly {
            alreadyClaimedInTx := tload(lockSlot)
        }
        if (alreadyClaimedInTx != 0) {
            revert ContractCallersNotAllowed();
        }

        uint256 lastCallerTime = lastFaucetTime[msg.sender];
        if (lastCallerTime != 0 && block.timestamp < lastCallerTime + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive((lastCallerTime + FAUCET_COOLDOWN) - block.timestamp);
        }

        uint256 lastToTime = lastFaucetTime[to];
        if (lastToTime != 0 && block.timestamp < lastToTime + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive((lastToTime + FAUCET_COOLDOWN) - block.timestamp);
        }

        _consumeFaucetBudget();

        assembly {
            tstore(lockSlot, 1)
        }
        lastFaucetTime[msg.sender] = block.timestamp;
        lastFaucetTime[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit FaucetUsed(to, FAUCET_AMOUNT, block.timestamp);
    }

    /**
     * @notice Production voucher-gated faucet claim supporting both EOAs and ERC-4337/EIP-7702 smart accounts.
     *         Requires an ECDSA signature from faucetSigner bound to (chainId, token, to, nonce, deadline),
     *         single-use nonce replay protection, 1-hour recipient cooldown, hourly epoch cap, and lifetime cap.
     * @param to Recipient address (EOA or smart account).
     * @param nonce Unique single-use voucher nonce.
     * @param deadline Unix timestamp after which the voucher expires.
     * @param signature 65-byte ECDSA signature from faucetSigner over EthSignedMessageHash.
     */
    function claimFaucetWithVoucher(
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!faucetEnabled) revert FaucetDisabled();
        if (to == address(0)) revert InvalidRecipient();
        address configuredSigner = faucetSigner;
        if (configuredSigner == address(0)) revert InvalidFaucetVoucher();
        if (block.timestamp > deadline) revert FaucetVoucherExpired();
        if (usedFaucetNonces[nonce]) revert FaucetVoucherUsed();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "GENOCHAIN_FAUCET_VOUCHER_V1",
                    block.chainid,
                    address(this),
                    to,
                    nonce,
                    deadline
                )
            )
        );
        (address recovered, ECDSA.RecoverError err, bytes32 errArg) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || errArg != bytes32(0) || recovered != configuredSigner) {
            revert InvalidFaucetVoucher();
        }

        uint256 lastToTime = lastFaucetTime[to];
        if (lastToTime != 0 && block.timestamp < lastToTime + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive((lastToTime + FAUCET_COOLDOWN) - block.timestamp);
        }

        _consumeFaucetBudget();
        usedFaucetNonces[nonce] = true;
        lastFaucetTime[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit FaucetUsed(to, FAUCET_AMOUNT, block.timestamp);
    }
}