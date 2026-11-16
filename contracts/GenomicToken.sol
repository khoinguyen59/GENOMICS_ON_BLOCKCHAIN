// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GenomicToken ($GENO)
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice ERC-20 utility and payment token for the Genomics on Blockchain ecosystem.
 * @dev Used for Escrow payment, access purchases, and distributing automatic royalties.
 *      Includes rate-limited faucet with 1-hour cooldown to prevent abuse.
 *      Inherits ERC20Burnable to enable token burning and control inflation.
 */
contract GenomicToken is ERC20, ERC20Burnable, Ownable {
    uint256 public constant INITIAL_SUPPLY = 10_000_000 * 10 ** 18; // 10 million $GENO
    uint256 public constant MAX_FAUCET_SUPPLY = 50_000_000 * 10 ** 18; // 50 million $GENO max faucet cap
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 18;       // 1,000 $GENO per faucet call
    uint256 public constant FAUCET_COOLDOWN = 1 hours;              // 1 hour cooldown between faucet claims

    mapping(address => uint256) public lastFaucetTime;

    event FaucetUsed(address indexed receiver, uint256 amount, uint256 timestamp);

    error InvalidRecipient();
    error FaucetCooldownActive(uint256 remainingSeconds);
    error ContractCallersNotAllowed();
    error FaucetMaxSupplyExceeded();

    constructor(address initialOwner) ERC20("Genomic Token", "GENO") Ownable(initialOwner) {
        _mint(initialOwner, INITIAL_SUPPLY);
    }

    /**
     * @notice Mint function restricted to contract owner
     * @param to Recipient address
     * @param amount Token amount in wei
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Public testnet/demo faucet to allow researchers and users to get test tokens.
     *         Enforces strict 1-hour rate-limit per caller and recipient address (INVARIANT-15 Anti-Sybil)
     *         and blocks smart contract / factory callers.
     * @param to Recipient of the faucet tokens
     */
    function faucet(address to) external {
        if (to == address(0)) revert InvalidRecipient();
        // solhint-disable-next-line avoid-tx-origin
        if (msg.sender != tx.origin || msg.sender.code.length > 0 || to.code.length > 0) {
            revert ContractCallersNotAllowed();
        }
        if (totalSupply() + FAUCET_AMOUNT > INITIAL_SUPPLY + MAX_FAUCET_SUPPLY) {
            revert FaucetMaxSupplyExceeded();
        }

        // Anti-Sybil protection: Enforce rate limit on caller (msg.sender)
        uint256 lastCallerTime = lastFaucetTime[msg.sender];
        if (lastCallerTime != 0 && block.timestamp < lastCallerTime + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive((lastCallerTime + FAUCET_COOLDOWN) - block.timestamp);
        }

        // Rate limit on recipient (to)
        uint256 lastToTime = lastFaucetTime[to];
        if (lastToTime != 0 && block.timestamp < lastToTime + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive((lastToTime + FAUCET_COOLDOWN) - block.timestamp);
        }

        lastFaucetTime[msg.sender] = block.timestamp;
        lastFaucetTime[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit FaucetUsed(to, FAUCET_AMOUNT, block.timestamp);
    }
}
