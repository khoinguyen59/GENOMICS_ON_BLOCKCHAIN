// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGenomicTokenFaucet
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Minimal faucet interface used by adversarial test mocks verifying anti-Sybil defenses.
 */
interface IGenomicTokenFaucet {
    /**
     * @notice Request demo faucet tokens for a recipient address.
     * @param to Recipient address.
     */
    function faucet(address to) external;
}