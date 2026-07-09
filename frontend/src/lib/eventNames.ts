/** The 11 events the UI surfaces in the live timeline (dashboard + transactions
 *  pages), matching the deployed AaveArbitrageExecutorV3 ABI exactly. */
export const TRACKED_EVENT_NAMES = [
  "FlashLoanStarted",
  "FlashLoanRepaid",
  "SwapExecuted",
  "ProfitRealized",
  "ArbitrageExecuted",
  "RouterUpdated",
  "AssetUpdated",
  "KeeperUpdated",
  "EmergencyAction",
  "WithdrawalRequested",
  "ProfitWithdrawn",
] as const;

export type TrackedEventName = (typeof TRACKED_EVENT_NAMES)[number];
