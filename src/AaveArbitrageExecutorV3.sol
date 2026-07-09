// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AaveArbitrageExecutorV3
 * @notice Owner/keeper-controlled flash-loan arbitrage executor for BNB Chain
 *         using Aave V3 flash loans, with a whitelisted, modular router
 *         architecture (V2-style, V3-style, and Curve/Ellipsis-style stable
 *         pools) and atomic 2- or 3-step (triangular) arbitrage paths.
 *
 * @dev THIS IS NOT AN AUDIT. Based on AaveArbitrageExecutorV2, extended with:
 *        - a separate `keeper` role so an automated off-chain bot can trigger
 *          trades from a hot wallet without holding owner privileges (the
 *          keeper can never touch whitelists, caps, or funds directly);
 *        - a third router type for Curve/Ellipsis/Wombat-style stable-swap
 *          pools, common for stable-stable triangular routes on BSC
 *          (e.g. USDT -> USDC -> BUSD -> USDT);
 *        - a `quoteBestOfV2` helper so a keeper can compare multiple V2-style
 *          routers for the same hop in a single call.
 *      Do not deploy with meaningful funds until tested and reviewed by
 *      someone other than the person who wrote/requested it.
 *
 * SECURITY MODEL (read this before deploying):
 *  - Owner (Ownable) controls whitelists, caps, fees, pause, and the keeper
 *    address. Keeper can only call executeArbitrage() with a caller-chosen
 *    cycle of whitelisted routers/assets already under owner-set caps and
 *    thresholds — it cannot change configuration or move funds itself.
 *  - executeOperation() is the Aave flash-loan callback. It is NOT
 *    nonReentrant because it is called by Aave synchronously from inside
 *    executeArbitrage(), which IS nonReentrant. Its safety instead comes from
 *    two checks: the caller must be the real Aave Pool, and the loan
 *    initiator must be this contract itself (i.e. a loan it just requested in
 *    the same transaction).
 *  - Router and asset whitelists are owner-controlled allowlists. Anything
 *    not explicitly added cannot be used, closing off a large class of
 *    "malicious router" and "unexpected token" attacks.
 */

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Minimal decimals() view — the standard IERC20 interface doesn't include it.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

// ============================================================
// External interfaces
// ============================================================

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @dev Covers PancakeSwap V2, Biswap, ApeSwap, and any other Uniswap-V2 fork.
interface IRouterV2 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

/// @dev Covers PancakeSwap V3, THENA (CL), and any Uniswap-V3-compatible router
///      that exposes the standard exactInputSingle signature.
interface IRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Covers PancakeSwap V3 / Uniswap-V3-compatible QuoterV2 for off-chain-free on-chain quoting.
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @dev Curve/Ellipsis-style stable-swap pool. Indices are per-pool token
///      slots (int128, matching Curve's original ABI), not addresses.
interface IStableSwap {
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
}

/// @dev Minimal Chainlink-compatible interface — avoids pulling in the full
///      full chainlink/contracts npm dependency just for this one call.
interface IChainlinkAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

contract AaveArbitrageExecutorV3 is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ============================================================
    // Types
    // ============================================================

    /// @dev A single-hop swap. Chaining 2 or 3 of these forms the full arbitrage cycle.
    ///      routerType: 0 = V2-style (getAmountsOut/swapExactTokensForTokens),
    ///                  1 = V3-style (QuoterV2/exactInputSingle),
    ///                  2 = Stable-style (Curve/Ellipsis get_dy/exchange).
    struct SwapStep {
        address router;
        address quoter;      // only used when routerType == 1; can be address(0) otherwise
        uint8 routerType;
        address tokenIn;
        address tokenOut;
        uint24 v3Fee;         // only used when routerType == 1
        int128 stableI;       // only used when routerType == 2: pool index of tokenIn
        int128 stableJ;       // only used when routerType == 2: pool index of tokenOut
    }

    // ============================================================
    // Immutables / constants
    // ============================================================

    address public immutable AAVE_POOL;
    uint16 private constant BPS_DENOMINATOR = 10_000;
    uint8 private constant ROUTER_TYPE_V2 = 0;
    uint8 private constant ROUTER_TYPE_V3 = 1;
    uint8 private constant ROUTER_TYPE_STABLE = 2;
    uint8 private constant MAX_STEPS = 3;

    // ============================================================
    // Storage (packed where practical)
    // ============================================================

    address public profitRecipient;
    /// @notice Automated hot-wallet allowed to call executeArbitrage(). Cannot
    ///         touch whitelists, caps, fees, pause, or withdrawals — those
    ///         remain onlyOwner. address(0) = no keeper set (owner-only).
    address public keeper;
    uint256 public minProfitThreshold;      // in the borrowed asset's smallest unit
    uint16 public minSpreadBPS;
    uint16 public defaultSlippageBPS;
    uint32 public deadlineWindow;
    uint32 public timelockDelay;
    uint256 public maxFlashLoanAmount;      // per-asset cap is in maxFlashLoanPerAsset; this is a global fallback (0 = no global cap)
    uint256 public estimatedGasUnits;       // owner-configurable estimate used in off-chain-facing preview functions
    uint16 public protocolFeeBPS;           // optional fee taken from profit before it reaches profitRecipient, sent to feeRecipient
    address public feeRecipient;

    uint256 private _lastOpBlock;
    uint256 public operationCount;
    uint256 public totalFlashLoansExecuted;
    uint256 public totalProfitRealized;

    uint256 private _preLoanBalance; // snapshot taken right before requesting a flash loan

    mapping(address => bool) public allowedRouters;
    mapping(address => bool) public allowedAssets;
    mapping(address => uint256) public maxFlashLoanPerAsset; // 0 = use maxFlashLoanAmount fallback, still 0 = unlimited if both 0

    /// @notice Chainlink-compatible USD price feed per token (e.g. Chainlink's
    ///         real BNB/USD, USDT/USD feeds on BSC). address(0) = no feed set,
    ///         oracle sanity check is skipped for that token.
    mapping(address => address) public priceFeeds;
    /// @notice Max allowed deviation between the DEX-implied price of the first
    ///         hop and the Chainlink oracle price, in basis points, before a
    ///         trade is rejected as suspicious (protects against a single
    ///         manipulated pool feeding a fake profitable spread).
    uint16 public maxOracleDeviationBPS;
    /// @notice How stale a Chainlink answer is allowed to be before it's
    ///         treated as unusable (protects against a frozen/stale feed).
    uint32 public maxOracleStaleness;

    mapping(bytes32 => uint256) public pendingWithdrawals;

    /// @dev Defense-in-depth flag, separate from the ReentrancyGuard lock on
    ///      executeArbitrage. Set true immediately before requesting the flash
    ///      loan, and cleared at the very start of executeOperation's actual
    ///      swap logic. If a malicious/hostile token in the swap path tries to
    ///      reenter executeOperation mid-swap (e.g. via an ERC-777-style hook),
    ///      this flag will already be false and the call reverts — independent
    ///      of the initiator/caller checks.
    bool private _flashLoanActive;

    // ============================================================
    // Events
    // ============================================================

    event FlashLoanStarted(address indexed asset, uint256 amount);
    event FlashLoanRepaid(address indexed asset, uint256 amount, uint256 premium);
    event SwapExecuted(address indexed router, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event ArbitrageExecuted(address indexed asset, uint256 amountBorrowed, uint256 grossProfit, uint256 protocolFee, uint256 netProfit);
    event ProfitRealized(address indexed asset, uint256 amount, address indexed recipient);
    event ProfitWithdrawn(bytes32 indexed requestId, address indexed token, address indexed to, uint256 amount);
    event RouterUpdated(address indexed router, bool allowed);
    event AssetUpdated(address indexed asset, bool allowed, uint256 maxFlashLoan);
    event EmergencyAction(string action, address indexed actor);
    event ConfigUpdated(string field, uint256 value);
    event ProfitRecipientUpdated(address indexed newRecipient);
    event WithdrawalRequested(bytes32 indexed requestId, address indexed token, uint256 amount);
    event KeeperUpdated(address indexed newKeeper);

    // ============================================================
    // Errors
    // ============================================================

    error InvalidAmount();
    error InvalidSlippage();
    error InvalidStepCount();
    error InvalidStep();
    error RouterNotAllowed();
    error AssetNotAllowed();
    error AmountExceedsCap();
    error SwapFailed();
    error InsufficientLiquidity();
    error ArbProfitBelowThreshold();
    error SpreadTooLow();
    error SameBlockReentry();
    error TimelockNotExpired();
    error WithdrawalRequestNotFound();
    error DeadlineExpired();
    error UnauthorizedCaller();
    error UnauthorizedInitiator();
    error UnauthorizedKeeper();
    error NativeTransferFailed();
    error ZeroAddress();
    error FeeTooHigh();
    error CycleMismatch();
    error DuplicateHop();

    // ============================================================
    // Modifiers
    // ============================================================

    /// @dev Blocks a second arbitrage call from landing in the same block, as a
    ///      cheap deterrent against a compromised key or bot spamming the owner's
    ///      own contract. Does NOT protect against front-running by third parties
    ///      (nothing on-chain can fully solve that without private orderflow).
    modifier oncePerBlock() {
        if (block.number == _lastOpBlock) revert SameBlockReentry();
        _lastOpBlock = block.number;
        _;
    }

    /// @dev Owner always allowed; keeper allowed only for trade execution.
    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && (keeper == address(0) || msg.sender != keeper)) revert UnauthorizedKeeper();
        _;
    }

    /// @param aavePool Real Aave V3 Pool address on BNB Chain.
    /// @param initialProfitRecipient Where net profit is sent after each trade.
    /// @param initialOwner Recommended: a Safe (multisig) address, not an EOA.
    ///        Ownable(msg.sender) would force a two-step transferOwnership()
    ///        dance after deploy; passing the Safe address directly here means
    ///        the contract is owned by the multisig from block one.
    constructor(address aavePool, address initialProfitRecipient, address initialOwner)
        Ownable(initialOwner)
    {
        if (aavePool == address(0) || initialProfitRecipient == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        AAVE_POOL = aavePool;
        profitRecipient = initialProfitRecipient;

        minProfitThreshold = 0;      // must be set explicitly per-asset by owner before first use
        minSpreadBPS = 30;           // 0.30%
        defaultSlippageBPS = 50;     // 0.50%
        deadlineWindow = 3 minutes;
        timelockDelay = 1 days;
        estimatedGasUnits = 800_000; // rough default; tune after measuring on testnet
        protocolFeeBPS = 0;
        feeRecipient = initialOwner;
        maxOracleDeviationBPS = 0;   // oracle checks off until you setPriceFeed() + this
        maxOracleStaleness = 3 hours;

        // Not 0: block.number is genuinely 0 on a freshly-started local
        // chain (anvil/hardhat) before the first block is mined. Leaving the
        // default storage value of 0 here would make oncePerBlock's very
        // first-ever call revert on such a chain, since block.number(0) ==
        // _lastOpBlock(0) would look like a same-block replay.
        _lastOpBlock = type(uint256).max;
    }

    // ============================================================
    // Admin: whitelists
    // ============================================================

    /// @notice Add or remove a router from the allowlist. Only whitelisted
    ///         routers can ever be called by this contract.
    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = allowed;
        emit RouterUpdated(router, allowed);
    }

    /// @notice Add or remove an asset from the allowlist and set its per-asset
    ///         flash-loan cap (0 = fall back to the global maxFlashLoanAmount).
    function setAssetAllowed(address asset, bool allowed, uint256 maxLoanForAsset) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        allowedAssets[asset] = allowed;
        maxFlashLoanPerAsset[asset] = maxLoanForAsset;
        emit AssetUpdated(asset, allowed, maxLoanForAsset);
    }

    /// @notice Sets (or clears with address(0)) the Chainlink-compatible USD
    ///         price feed for a token. Only tokens with a feed set are
    ///         oracle-checked before a trade; others skip the sanity check.
    function setPriceFeed(address token, address feed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        priceFeeds[token] = feed;
        emit ConfigUpdated("priceFeed", uint256(uint160(feed)));
    }

    function setMaxOracleDeviationBPS(uint16 newDeviationBPS) external onlyOwner {
        if (newDeviationBPS > 5_000) revert InvalidSlippage(); // sanity cap at 50%
        maxOracleDeviationBPS = newDeviationBPS;
        emit ConfigUpdated("maxOracleDeviationBPS", newDeviationBPS);
    }

    function setMaxOracleStaleness(uint32 newStaleness) external onlyOwner {
        maxOracleStaleness = newStaleness;
        emit ConfigUpdated("maxOracleStaleness", newStaleness);
    }

    // ============================================================
    // Admin: configuration
    // ============================================================

    function setProfitRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        profitRecipient = newRecipient;
        emit ProfitRecipientUpdated(newRecipient);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        feeRecipient = newRecipient;
    }

    /// @notice Sets the automated keeper hot wallet (address(0) disables
    ///         keeper-triggered execution, leaving only the owner able to call
    ///         executeArbitrage). The keeper can never change whitelists,
    ///         caps, fees, recipients, or withdraw funds — only trigger trades
    ///         that are already constrained by owner-set config.
    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    function setProtocolFeeBPS(uint16 newFeeBPS) external onlyOwner {
        if (newFeeBPS > 2_000) revert FeeTooHigh(); // hard cap at 20% of profit
        protocolFeeBPS = newFeeBPS;
        emit ConfigUpdated("protocolFeeBPS", newFeeBPS);
    }

    function setMinProfitThreshold(uint256 newThreshold) external onlyOwner {
        minProfitThreshold = newThreshold;
        emit ConfigUpdated("minProfitThreshold", newThreshold);
    }

    function setMinSpreadBPS(uint16 newSpreadBPS) external onlyOwner {
        if (newSpreadBPS > 2_000) revert InvalidSlippage();
        minSpreadBPS = newSpreadBPS;
        emit ConfigUpdated("minSpreadBPS", newSpreadBPS);
    }

    function setDefaultSlippageBPS(uint16 newSlippageBPS) external onlyOwner {
        if (newSlippageBPS > 2_000) revert InvalidSlippage();
        defaultSlippageBPS = newSlippageBPS;
        emit ConfigUpdated("defaultSlippageBPS", newSlippageBPS);
    }

    function setDeadlineWindow(uint32 newWindow) external onlyOwner {
        if (newWindow == 0 || newWindow > 30 minutes) revert InvalidAmount();
        deadlineWindow = newWindow;
        emit ConfigUpdated("deadlineWindow", newWindow);
    }

    function setMaxFlashLoanAmount(uint256 newMax) external onlyOwner {
        maxFlashLoanAmount = newMax;
        emit ConfigUpdated("maxFlashLoanAmount", newMax);
    }

    function setEstimatedGasUnits(uint256 units) external onlyOwner {
        estimatedGasUnits = units;
        emit ConfigUpdated("estimatedGasUnits", units);
    }

    function emergencyPause() external onlyOwner {
        _pause();
        emit EmergencyAction("pause", msg.sender);
    }

    function emergencyUnpause() external onlyOwner {
        _unpause();
        emit EmergencyAction("unpause", msg.sender);
    }

    // ============================================================
    // Entry point: atomic 2- or 3-step arbitrage
    // ============================================================

    /**
     * @notice Executes a flash-loan-funded arbitrage cycle. `steps` must form a
     *         closed loop starting and ending at `asset`, e.g. for 2 steps:
     *         asset -> tokenX -> asset. For 3 steps (triangular): asset -> X -> Y -> asset.
     *         Callable by the owner or the configured keeper bot.
     * @param asset The token to flash-borrow. Must be whitelisted.
     * @param amount Flash loan amount. Must respect the per-asset / global cap.
     * @param steps 2 or 3 single-hop swaps forming a closed cycle.
     * @param minProfit Minimum acceptable net profit for this specific call
     *                  (in addition to the global minProfitThreshold).
     * @param slippageBPS 0 = use defaultSlippageBPS.
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        SwapStep[] calldata steps,
        uint256 minProfit,
        uint16 slippageBPS
    ) external onlyOwnerOrKeeper whenNotPaused nonReentrant oncePerBlock {
        if (amount == 0) revert InvalidAmount();
        if (!allowedAssets[asset]) revert AssetNotAllowed();
        if (slippageBPS > 2_000) revert InvalidSlippage();

        uint256 cap = maxFlashLoanPerAsset[asset] != 0 ? maxFlashLoanPerAsset[asset] : maxFlashLoanAmount;
        if (cap != 0 && amount > cap) revert AmountExceedsCap();

        _validateSteps(asset, steps);

        uint16 effectiveSlippage = slippageBPS == 0 ? defaultSlippageBPS : slippageBPS;

        // Quote the full cycle before paying for a flash loan that can't be profitable.
        uint256 quotedOut = _quoteCycle(steps, amount);
        if (quotedOut <= amount) revert SpreadTooLow();
        uint256 spreadBPS = ((quotedOut - amount) * BPS_DENOMINATOR) / amount;
        if (spreadBPS < minSpreadBPS) revert SpreadTooLow();

        // Cross-check the first hop's DEX-implied price against Chainlink, if
        // feeds are configured for both tokens. Catches the classic single-pool
        // manipulation setup where a pool is pushed far off the true market
        // price right before this contract's transaction lands.
        _checkOracleSanity(steps[0], amount);

        operationCount++;
        _preLoanBalance = IERC20(asset).balanceOf(address(this));
        _flashLoanActive = true;

        bytes memory params = abi.encode(steps, minProfit, effectiveSlippage);

        emit FlashLoanStarted(asset, amount);
        IAavePool(AAVE_POOL).flashLoanSimple(address(this), asset, amount, params, 0);
        totalFlashLoansExecuted++;
    }

    /// @notice Basis-point deviation between a DEX quote and the Chainlink
    ///         cross-rate for the same pair, above which a trade is rejected.
    error OracleDeviationTooHigh(uint256 dexRateWad, uint256 oracleRateWad, uint256 deviationBPS);
    error StaleOracleRound();

    /// @dev Compares the DEX-implied price of the FIRST hop only (tokenIn ->
    ///      tokenOut, using the exact router/quoter from that SwapStep) against
    ///      the Chainlink cross-rate for the same pair. Both sides are
    ///      normalized to a common 1e18 fixed-point rate before comparing, so
    ///      differing token decimals and differing Chainlink feed decimals are
    ///      both handled correctly. Skips silently if either token has no feed
    ///      configured, or if maxOracleDeviationBPS == 0 (oracle check is off).
    function _checkOracleSanity(SwapStep memory firstStep, uint256 amount) internal {
        if (maxOracleDeviationBPS == 0) return;

        address feedIn = priceFeeds[firstStep.tokenIn];
        address feedOut = priceFeeds[firstStep.tokenOut];
        if (feedIn == address(0) || feedOut == address(0)) return;

        // --- 1) DEX-implied rate for the first hop, using its own router/quoter ---
        uint256 firstHopAmountOut = _quoteSingleHop(firstStep, amount);
        if (firstHopAmountOut == 0) revert InsufficientLiquidity();

        uint8 decIn = IERC20Decimals(firstStep.tokenIn).decimals();
        uint8 decOut = IERC20Decimals(firstStep.tokenOut).decimals();

        // Price of 1 whole tokenIn, expressed in whole tokenOut units, as a 1e18 fixed-point number:
        //   dexRateWad = (amountOut / 10^decOut) / (amountIn / 10^decIn) * 1e18
        //              = amountOut * 10^decIn * 1e18 / (amountIn * 10^decOut)
        uint256 dexRateWad = Math.mulDiv(
            firstHopAmountOut * (10 ** decIn),
            1e18,
            amount * (10 ** decOut)
        );

        // --- 2) Chainlink cross-rate for the same pair ---
        (int256 priceIn, uint8 feedDecIn) = _requireFreshPositivePrice(feedIn);
        (int256 priceOut, uint8 feedDecOut) = _requireFreshPositivePrice(feedOut);

        // Price of 1 whole tokenIn in whole tokenOut units:
        //   oracleRateWad = (priceIn / 10^feedDecIn) / (priceOut / 10^feedDecOut) * 1e18
        //                 = priceIn * 10^feedDecOut * 1e18 / (priceOut * 10^feedDecIn)
        uint256 oracleRateWad = Math.mulDiv(
            uint256(priceIn) * (10 ** feedDecOut),
            1e18,
            uint256(priceOut) * (10 ** feedDecIn)
        );

        // --- 3) Deviation check ---
        uint256 diff = dexRateWad > oracleRateWad ? dexRateWad - oracleRateWad : oracleRateWad - dexRateWad;
        uint256 deviationBPS = Math.mulDiv(diff, BPS_DENOMINATOR, oracleRateWad);

        if (deviationBPS > maxOracleDeviationBPS) {
            revert OracleDeviationTooHigh(dexRateWad, oracleRateWad, deviationBPS);
        }
    }

    /// @dev Quotes a single hop using the step's own router (V2), quoter (V3),
    ///      or pool (Stable), without executing anything.
    function _quoteSingleHop(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        if (step.routerType == ROUTER_TYPE_V2) {
            address[] memory path = new address[](2);
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;
            uint256[] memory out = IRouterV2(step.router).getAmountsOut(amountIn, path);
            return out[out.length - 1];
        } else if (step.routerType == ROUTER_TYPE_V3) {
            IQuoterV2.QuoteExactInputSingleParams memory qParams = IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: step.tokenIn,
                tokenOut: step.tokenOut,
                amountIn: amountIn,
                fee: step.v3Fee,
                sqrtPriceLimitX96: 0
            });
            (uint256 amountOut, , , ) = IQuoterV2(step.quoter).quoteExactInputSingle(qParams);
            return amountOut;
        } else {
            return IStableSwap(step.router).get_dy(step.stableI, step.stableJ, amountIn);
        }
    }

    /// @dev Returns (answer, feedDecimals) after validating the round is fresh,
    ///      positive, and fully settled. `answeredInRound >= roundId` rejects
    ///      answers carried over from an earlier, incomplete round — a classic
    ///      signal of a frozen or malfunctioning feed.
    function _requireFreshPositivePrice(address feed) internal view returns (int256, uint8) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            IChainlinkAggregator(feed).latestRoundData();
        if (answer <= 0) revert InsufficientLiquidity();
        if (answeredInRound < roundId) revert StaleOracleRound();
        if (maxOracleStaleness != 0 && block.timestamp - updatedAt > maxOracleStaleness) revert StaleOracleRound();
        return (answer, IChainlinkAggregator(feed).decimals());
    }

    function _validateSteps(address asset, SwapStep[] calldata steps) internal view {
        uint256 len = steps.length;
        if (len < 2 || len > MAX_STEPS) revert InvalidStepCount();
        if (steps[0].tokenIn != asset) revert CycleMismatch();
        if (steps[len - 1].tokenOut != asset) revert CycleMismatch();

        for (uint256 i = 0; i < len; i++) {
            SwapStep calldata s = steps[i];
            if (s.router == address(0) || s.tokenIn == address(0) || s.tokenOut == address(0)) revert ZeroAddress();
            if (s.tokenIn == s.tokenOut) revert DuplicateHop();
            if (!allowedRouters[s.router]) revert RouterNotAllowed();
            if (s.routerType == ROUTER_TYPE_V3 && s.quoter == address(0)) revert InvalidStep();
            if (s.routerType == ROUTER_TYPE_STABLE && s.stableI == s.stableJ) revert InvalidStep();
            if (s.routerType > ROUTER_TYPE_STABLE) revert InvalidStep();
            if (i > 0 && steps[i - 1].tokenOut != s.tokenIn) revert CycleMismatch();
        }
    }

    // ============================================================
    // Aave V3 callback
    // ============================================================

    /// @dev Deliberately NOT nonReentrant — see contract-level security notes.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != AAVE_POOL) revert UnauthorizedCaller();
        if (initiator != address(this)) revert UnauthorizedInitiator();
        if (!_flashLoanActive) revert UnauthorizedCaller();
        // Clear immediately: if a hostile token hook tries to re-enter this
        // function during the swaps below, this check fails on the reentrant call.
        _flashLoanActive = false;

        (SwapStep[] memory steps, uint256 minProfit, uint16 slippageBPS) =
            abi.decode(params, (SwapStep[], uint256, uint16));

        _runSwapCycle(steps, amount, slippageBPS);
        _settleAndDistribute(asset, amount, premium, minProfit);

        return true;
    }

    /// @dev Split out of executeOperation purely to keep that function's local
    ///      variable count low enough to avoid "stack too deep" — no behavior
    ///      change versus having this inline.
    function _runSwapCycle(SwapStep[] memory steps, uint256 amount, uint16 slippageBPS) internal {
        uint256 deadline = block.timestamp + deadlineWindow;
        uint256 runningAmount = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            runningAmount = _executeSwap(steps[i], runningAmount, slippageBPS, deadline);
        }
    }

    /// @dev Computes profit, repays Aave, and forwards fee + net profit.
    ///      Split out of executeOperation for the same stack-depth reason as
    ///      _runSwapCycle above. Follows CEI: all accounting/events happen
    ///      before the external transfer calls at the bottom.
    function _settleAndDistribute(address asset, uint256 amount, uint256 premium, uint256 minProfit) internal {
        uint256 totalOwed = amount + premium;
        uint256 requiredBalance = _preLoanBalance + totalOwed;
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));

        if (balanceAfter < requiredBalance) revert ArbProfitBelowThreshold();
        uint256 grossProfit = balanceAfter - requiredBalance;
        if (grossProfit < minProfit || grossProfit < minProfitThreshold) revert ArbProfitBelowThreshold();

        uint256 fee = (grossProfit * protocolFeeBPS) / BPS_DENOMINATOR;
        uint256 netProfit = grossProfit - fee;
        totalProfitRealized += netProfit;

        emit FlashLoanRepaid(asset, amount, premium);
        emit ArbitrageExecuted(asset, amount, grossProfit, fee, netProfit);

        IERC20(asset).forceApprove(AAVE_POOL, totalOwed);

        if (fee > 0 && feeRecipient != address(0)) {
            IERC20(asset).safeTransfer(feeRecipient, fee);
        }
        if (netProfit > 0) {
            IERC20(asset).safeTransfer(profitRecipient, netProfit);
            emit ProfitRealized(asset, netProfit, profitRecipient);
        }
    }

    // ============================================================
    // Swap execution
    // ============================================================

    function _executeSwap(SwapStep memory step, uint256 amountIn, uint16 slippageBPS, uint256 deadline)
        internal
        returns (uint256 amountOut)
    {
        if (deadline < block.timestamp) revert DeadlineExpired();

        if (step.routerType == ROUTER_TYPE_V2) {
            amountOut = _swapV2(step, amountIn, slippageBPS, deadline);
        } else if (step.routerType == ROUTER_TYPE_V3) {
            amountOut = _swapV3(step, amountIn, slippageBPS, deadline);
        } else {
            amountOut = _swapStable(step, amountIn, slippageBPS);
        }

        if (amountOut == 0) revert SwapFailed();
        emit SwapExecuted(step.router, step.tokenIn, step.tokenOut, amountIn, amountOut);
    }

    function _swapV2(SwapStep memory step, uint256 amountIn, uint16 slippageBPS, uint256 deadline)
        internal
        returns (uint256 amountOut)
    {
        address[] memory path = new address[](2);
        path[0] = step.tokenIn;
        path[1] = step.tokenOut;

        uint256[] memory quoted = IRouterV2(step.router).getAmountsOut(amountIn, path);
        uint256 quotedOut = quoted[quoted.length - 1];
        if (quotedOut == 0) revert InsufficientLiquidity();
        uint256 amountOutMin = (quotedOut * (BPS_DENOMINATOR - slippageBPS)) / BPS_DENOMINATOR;

        IERC20(step.tokenIn).forceApprove(step.router, amountIn);
        uint256[] memory amounts = IRouterV2(step.router).swapExactTokensForTokens(
            amountIn, amountOutMin, path, address(this), deadline
        );
        amountOut = amounts[amounts.length - 1];

        // Reset approval to zero so a leftover allowance can never be reused
        // by a router if this contract is later pointed at a bad path.
        IERC20(step.tokenIn).forceApprove(step.router, 0);
    }

    function _swapV3(SwapStep memory step, uint256 amountIn, uint16 slippageBPS, uint256 deadline)
        internal
        returns (uint256 amountOut)
    {
        IQuoterV2.QuoteExactInputSingleParams memory qParams = IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            amountIn: amountIn,
            fee: step.v3Fee,
            sqrtPriceLimitX96: 0
        });
        (uint256 quotedOut, , , ) = IQuoterV2(step.quoter).quoteExactInputSingle(qParams);
        if (quotedOut == 0) revert InsufficientLiquidity();
        uint256 amountOutMin = (quotedOut * (BPS_DENOMINATOR - slippageBPS)) / BPS_DENOMINATOR;

        IERC20(step.tokenIn).forceApprove(step.router, amountIn);

        IRouterV3.ExactInputSingleParams memory swapParams = IRouterV3.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            fee: step.v3Fee,
            recipient: address(this),
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        amountOut = IRouterV3(step.router).exactInputSingle(swapParams);

        IERC20(step.tokenIn).forceApprove(step.router, 0);
    }

    function _swapStable(SwapStep memory step, uint256 amountIn, uint16 slippageBPS)
        internal
        returns (uint256 amountOut)
    {
        uint256 quotedOut = IStableSwap(step.router).get_dy(step.stableI, step.stableJ, amountIn);
        if (quotedOut == 0) revert InsufficientLiquidity();
        uint256 amountOutMin = (quotedOut * (BPS_DENOMINATOR - slippageBPS)) / BPS_DENOMINATOR;

        IERC20(step.tokenIn).forceApprove(step.router, amountIn);
        amountOut = IStableSwap(step.router).exchange(step.stableI, step.stableJ, amountIn, amountOutMin);
        IERC20(step.tokenIn).forceApprove(step.router, 0);
    }

    // ============================================================
    // Off-chain-facing preview / estimation helpers
    // ============================================================

    /// @notice Quotes the full swap cycle without executing it. Reverts if any
    ///         hop has zero liquidity. Does not require a flash loan or gas
    ///         beyond a normal view call (V3/Stable legs use non-view calls,
    ///         so this function is non-view; call it with eth_call from a bot).
    function previewArbitrage(address asset, uint256 amount, SwapStep[] calldata steps)
        external
        returns (uint256 finalAmountOut)
    {
        _validateSteps(asset, steps);
        return _quoteCycle(steps, amount);
    }

    /// @notice Gross spread in basis points for a given cycle and amount.
    function previewSpread(address asset, uint256 amount, SwapStep[] calldata steps)
        external
        returns (uint256 spreadBPS)
    {
        _validateSteps(asset, steps);
        uint256 out = _quoteCycle(steps, amount);
        if (out <= amount) return 0;
        return ((out - amount) * BPS_DENOMINATOR) / amount;
    }

    /// @notice Aave V3 flash loan premium for a given amount (0.05% as of writing;
    ///         confirm current rate on Aave's docs before relying on this).
    function estimateFlashLoanFee(uint256 amount) public pure returns (uint256) {
        return (amount * 5) / 10_000; // 0.05%
    }

    /// @notice Rough gas cost estimate in native BNB, using the owner-configured
    ///         estimatedGasUnits and the current tx.gasprice at call time.
    function estimateGasCost() external view returns (uint256) {
        return estimatedGasUnits * tx.gasprice;
    }

    /// @notice Net profit estimate in the borrowed asset, ignoring gas (gas is
    ///         paid in BNB, not directly comparable without a price feed — a
    ///         bot should convert estimateGasCost() to `asset` terms itself).
    function expectedNetProfit(address asset, uint256 amount, SwapStep[] calldata steps)
        external
        returns (uint256 netProfit)
    {
        uint256 grossOut = _quoteCycle(steps, amount);
        uint256 fee = estimateFlashLoanFee(amount);
        uint256 totalOwed = amount + fee;
        if (grossOut <= totalOwed) return 0;
        uint256 grossProfit = grossOut - totalOwed;
        uint256 protocolCut = (grossProfit * protocolFeeBPS) / BPS_DENOMINATOR;
        netProfit = grossProfit - protocolCut;
    }

    /// @notice Compares multiple whitelisted V2-style routers for the same
    ///         tokenIn/tokenOut hop and returns the best quoted output and its
    ///         index. Lets a keeper pick the best-priced DEX for a hop in one
    ///         call instead of one eth_call per router.
    function quoteBestOfV2(address[] calldata routers, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 bestIndex, uint256 bestOut)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        for (uint256 i = 0; i < routers.length; i++) {
            if (!allowedRouters[routers[i]]) continue;
            try IRouterV2(routers[i]).getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
                uint256 out = amounts[amounts.length - 1];
                if (out > bestOut) {
                    bestOut = out;
                    bestIndex = i;
                }
            } catch {
                continue;
            }
        }
    }

    function supportedRouters(address[] calldata routers) external view returns (bool[] memory allowed) {
        allowed = new bool[](routers.length);
        for (uint256 i = 0; i < routers.length; i++) {
            allowed[i] = allowedRouters[routers[i]];
        }
    }

    function supportedAssets(address[] calldata assets) external view returns (bool[] memory allowed) {
        allowed = new bool[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            allowed[i] = allowedAssets[assets[i]];
        }
    }

    function _quoteCycle(SwapStep[] memory steps, uint256 amount) internal returns (uint256) {
        uint256 running = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            running = _quoteSingleHop(steps[i], running);
            if (running == 0) revert InsufficientLiquidity();
        }
        return running;
    }

    // ============================================================
    // Timelocked withdrawal + emergency functions
    // ============================================================

    function requestWithdrawal(address token, uint256 amount) external onlyOwner returns (bytes32 requestId) {
        requestId = keccak256(abi.encodePacked(token, amount, block.timestamp, operationCount));
        pendingWithdrawals[requestId] = block.timestamp;
        emit WithdrawalRequested(requestId, token, amount);
    }

    function executeWithdrawal(bytes32 requestId, address token, address to, uint256 amount) external onlyOwner {
        uint256 requestTime = pendingWithdrawals[requestId];
        if (requestTime == 0) revert WithdrawalRequestNotFound();
        if (block.timestamp < requestTime + timelockDelay) revert TimelockNotExpired();
        if (to == address(0)) revert ZeroAddress();

        delete pendingWithdrawals[requestId];

        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }

        emit ProfitWithdrawn(requestId, token, to, amount);
    }

    /// @notice Rescues tokens that ended up in this contract outside of normal
    ///         arbitrage flow (e.g. sent by mistake). No timelock — intended for
    ///         genuinely stuck/foreign tokens, not for bypassing the profit path.
    /// @dev IMPORTANT: this function does NOT apply protocolFeeBPS, because by
    ///      design net profit and the protocol fee are both transferred out
    ///      automatically at the end of every successful executeOperation() —
    ///      there is normally no accrued, fee-pending profit sitting in this
    ///      contract for rescueTokens to intercept. If you ever see a balance
    ///      here it's either dust from rounding, a stuck failed-transfer edge
    ///      case, or a token sent by mistake — not unpaid protocol fee.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyAction("rescueTokens", msg.sender);
    }

    function rescueNative(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        (bool ok, ) = payable(to).call{value: balance}("");
        if (!ok) revert NativeTransferFailed();
        emit EmergencyAction("rescueNative", msg.sender);
    }

    // ============================================================
    // View functions
    // ============================================================

    function getBalance(address token) external view returns (uint256) {
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }

    function getOperationStats()
        external
        view
        returns (uint256 totalOps, uint256 flashLoans, uint256 profit)
    {
        return (operationCount, totalFlashLoansExecuted, totalProfitRealized);
    }

    receive() external payable {}
}
