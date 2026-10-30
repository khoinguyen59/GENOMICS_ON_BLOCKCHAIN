// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title NonStandardERC20
 * @notice Simulates a non-standard ERC20 token (like USDT) that does NOT return
 *         a boolean value from transfer() and transferFrom().
 *         Used to test SafeERC20 resilience as specified in Trail of Bits guidelines.
 */
contract NonStandardERC20 {
    string public name = "Non-Standard Token";
    string public symbol = "NST";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        balanceOf[msg.sender] = initialSupply;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    // NOTICE: Returns void, not bool! (USDT behavior)
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    // NOTICE: Returns void, not bool! (USDT behavior)
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        if (msg.sender != from && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
