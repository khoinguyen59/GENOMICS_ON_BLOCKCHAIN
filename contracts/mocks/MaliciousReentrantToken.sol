// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../GenomicsRegistry.sol";

/**
 * @title MaliciousReentrantToken
 * @notice ERC20 token with a transfer hook that attempts to re-enter GenomicsRegistry.grantAccess
 *         to simulate reentrancy on payment tokens (e.g. ERC777/ERC1363 callbacks).
 */
contract MaliciousReentrantToken is ERC20 {
    GenomicsRegistry public registry;
    bool public attackInitiated;
    bool public attackSucceeded;
    string public lastErrorMessage;
    uint256 public targetDataId;

    constructor(address initialOwner) ERC20("Malicious Token", "MAL") {
        _mint(initialOwner, 1000000 ether);
    }

    function setRegistryAndTarget(address _registry, uint256 _dataId) external {
        registry = GenomicsRegistry(_registry);
        targetDataId = _dataId;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!attackInitiated && address(registry) != address(0)) {
            attackInitiated = true;
            // Attempt to re-enter grantAccess
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
