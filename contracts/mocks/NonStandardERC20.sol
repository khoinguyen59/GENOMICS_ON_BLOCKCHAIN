// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title NonStandardERC20
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 * @notice Simulates a non-standard ERC20 token (like USDT) that does NOT return
 *         a boolean value from transfer() and transferFrom().
 *         Used to test SafeERC20 resilience as specified in Trail of Bits guidelines.
 */
contract NonStandardERC20 {
    /// @notice Token display name.
    string public name = "Non-Standard Token";
    /// @notice Token ticker symbol.
    string public symbol = "NST";
    /// @notice Token decimal precision.
    uint8 public decimals = 18;

    /// @notice Account token balances.
    mapping(address => uint256) public balanceOf;
    /// @notice Owner => spender token allowances.
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Thrown when sender balance is insufficient for transfer.
    error InsufficientBalance();
    /// @notice Thrown when spender allowance is insufficient for transferFrom.
    error InsufficientAllowance();

    /**
     * @notice Emitted on token transfers.
     * @param from Sender address.
     * @param to Recipient address.
     * @param value Transfer amount.
     */
    event Transfer(address indexed from, address indexed to, uint256 indexed value);

    /**
     * @notice Emitted on allowance approvals.
     * @param owner Token owner address.
     * @param spender Approved spender address.
     * @param value Approved amount.
     */
    event Approval(address indexed owner, address indexed spender, uint256 indexed value);

    /**
     * @notice Deploy NonStandardERC20 and mint initialSupply to deployer.
     * @param initialSupply Initial token supply.
     */
    constructor(uint256 initialSupply) {
        balanceOf[msg.sender] = initialSupply;
    }

    /**
     * @notice Approve spender to transfer up to amount tokens.
     * @param spender Spender address.
     * @param amount Allowance amount.
     */
    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    /**
     * @notice Transfer tokens without returning a bool (USDT behavior).
     * @param to Recipient address.
     * @param amount Transfer amount.
     */
    function transfer(address to, uint256 amount) external {
        // solhint-disable-next-line gas-custom-errors, gas-strict-inequalities
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    /**
     * @notice Transfer tokens on behalf of from without returning a bool (USDT behavior).
     * @param from Source address.
     * @param to Recipient address.
     * @param amount Transfer amount.
     */
    function transferFrom(address from, address to, uint256 amount) external {
        // solhint-disable-next-line gas-custom-errors, gas-strict-inequalities
        require(balanceOf[from] >= amount, "Insufficient balance");
        if (msg.sender != from && allowance[from][msg.sender] != type(uint256).max) {
            // solhint-disable-next-line gas-custom-errors, gas-strict-inequalities
            require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
