// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title GenomicTimelock
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Production governance TimelockController wrapping OpenZeppelin's audited TimelockController
 *         for delayed, transparent administration of GenomicToken, GenomicNFT, GenomicsRegistry,
 *         and GenomicZkVerifier (supporting Ownable2Step ownership handoff via scheduled acceptOwnership).
 * @dev Deploy with a multi-sig proposer/executor set and `admin = address(0)` so the timelock is
 *      strictly self-governed on mainnet/testnet deployments.
 */
contract GenomicTimelock is TimelockController {
    /**
     * @notice Initialize the GenomicTimelock governance controller.
     * @param minDelay Minimum delay in seconds between scheduling and executing governance proposals.
     * @param proposers Addresses authorized to schedule and cancel timelocked governance operations.
     * @param executors Addresses authorized to execute ready operations (or `[address(0)]` for open execution).
     * @param admin Optional initial admin address (`address(0)` recommended for self-administered governance).
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}