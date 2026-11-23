// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { GenomicsRegistry } from "../GenomicsRegistry.sol";

/**
 * @title MaliciousReentrantToken
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice ERC20 token with a transfer hook that attempts to re-enter GenomicsRegistry.grantAccess
 *         to simulate reentrancy on payment tokens (e.g. ERC777/ERC1363 callbacks).
 */
contract MaliciousReentrantToken is ERC20 {
    /// @notice Target GenomicsRegistry contract under reentrancy test.
    GenomicsRegistry public registry;
    /// @notice True once a reentrancy attempt has been initiated.
    bool public attackInitiated;
    /// @notice True if the nested reentrant call unexpectedly succeeded.
    bool public attackSucceeded;
    /// @notice Captured revert message from the blocked reentrant call.
    string public lastErrorMessage;
    /// @notice Dataset identifier targeted by the reentrant call.
    uint256 public targetDataId;

    /**
     * @notice Deploy mock malicious token and mint 1,000,000 MAL to initialOwner.
     * @param initialOwner Recipient of initial test supply.
     */
    constructor(address initialOwner) ERC20("Malicious Token", "MAL") {
        _mint(initialOwner, 1000000 ether);
    }

    /**
     * @notice Configure the target GenomicsRegistry and dataId for the reentrancy hook.
     * @param _registry Target GenomicsRegistry address.
     * @param _dataId Target dataset identifier.
     */
    function setRegistryAndTarget(address _registry, uint256 _dataId) external {
        registry = GenomicsRegistry(_registry);
        targetDataId = _dataId;
    }

    /**
     * @notice ERC-20 transferFrom override that attempts to re-enter GenomicsRegistry.grantAccess.
     * @param from Token sender address.
     * @param to Token recipient address.
     * @param amount Transfer amount in wei.
     * @return success True when transfer succeeds.
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool success) {
        if (!attackInitiated && address(registry) != address(0)) {
            attackInitiated = true;
            try registry.grantAccess(targetDataId) {
                attackSucceeded = true;
            } catch Error(string memory reason) {
                lastErrorMessage = reason;
            } catch (bytes memory) {
                lastErrorMessage = "ReentrancyGuardReentrantCall()";
            }
        }
        return super.transferFrom(from, to, amount);
    }
}
