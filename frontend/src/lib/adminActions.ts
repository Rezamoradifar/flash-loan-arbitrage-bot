import type { AdminActionSpec } from "@/components/admin/admin-action-form";

export interface AdminGroup {
  key: string;
  title: string;
  description: string;
  actions: AdminActionSpec[];
}

export const ADMIN_GROUPS: AdminGroup[] = [
  {
    key: "router",
    title: "Router Manager",
    description: "Whitelist or remove DEX router contracts that executeArbitrage() is allowed to call.",
    actions: [
      {
        functionName: "setRouterAllowed",
        title: "Set Router Allowed",
        description: "Whitelist or de-whitelist a router address.",
        fields: [
          { name: "router", type: "address", label: "Router Address", placeholder: "0x..." },
          { name: "allowed", type: "bool", label: "Allowed" },
        ],
      },
    ],
  },
  {
    key: "asset",
    title: "Asset Manager",
    description: "Whitelist assets eligible for flash-loan borrowing and set per-asset caps/thresholds.",
    actions: [
      {
        functionName: "setAssetAllowed",
        title: "Set Asset Allowed",
        description: "Whitelist or de-whitelist an asset, with a max flash-loan amount for that asset.",
        fields: [
          { name: "asset", type: "address", label: "Asset Address", placeholder: "0x..." },
          { name: "allowed", type: "bool", label: "Allowed" },
          { name: "maxLoanForAsset", type: "uint", label: "Max Loan (wei)", placeholder: "0" },
        ],
      },
      {
        functionName: "setMinProfitThresholdForAsset",
        title: "Set Per-Asset Min Profit",
        description: "Override the global minimum profit threshold for a specific asset.",
        fields: [
          { name: "asset", type: "address", label: "Asset Address", placeholder: "0x..." },
          { name: "newThreshold", type: "uint", label: "Min Profit (wei)", placeholder: "0" },
        ],
      },
    ],
  },
  {
    key: "pricefeed",
    title: "Price Feed Manager",
    description: "Configure Chainlink price feed addresses used for oracle sanity checks and gas-cost conversion.",
    actions: [
      {
        functionName: "setPriceFeed",
        title: "Set Price Feed",
        description: "Assign a Chainlink aggregator address to a token.",
        fields: [
          { name: "token", type: "address", label: "Token Address", placeholder: "0x..." },
          { name: "feed", type: "address", label: "Chainlink Feed Address", placeholder: "0x..." },
        ],
      },
    ],
  },
  {
    key: "keeper",
    title: "Keeper Manager",
    description: "Update the address authorized to call executeArbitrage().",
    actions: [
      {
        functionName: "setKeeper",
        title: "Set Keeper",
        description: "Assign the keeper (bot) address.",
        fields: [{ name: "newKeeper", type: "address", label: "New Keeper Address", placeholder: "0x..." }],
      },
    ],
  },
  {
    key: "emergency",
    title: "Emergency Controls",
    description: "Immediately halt or resume all arbitrage execution.",
    actions: [
      { functionName: "emergencyPause", title: "Emergency Pause", description: "Pause all execution immediately.", fields: [], destructive: true, confirmText: "Pause the contract? No new arbitrage will execute until unpaused." },
      { functionName: "emergencyUnpause", title: "Emergency Unpause", description: "Resume execution.", fields: [] },
    ],
  },
  {
    key: "profit",
    title: "Profit Settings",
    description: "Configure where profit and protocol fees are sent, and minimum profitability requirements.",
    actions: [
      {
        functionName: "setProfitRecipient",
        title: "Set Profit Recipient",
        description: "Address that receives realized arbitrage profit.",
        fields: [{ name: "newRecipient", type: "address", label: "Recipient", placeholder: "0x..." }],
      },
      {
        functionName: "setFeeRecipient",
        title: "Set Fee Recipient",
        description: "Address that receives protocol fees.",
        fields: [{ name: "newRecipient", type: "address", label: "Recipient", placeholder: "0x..." }],
      },
      {
        functionName: "setProtocolFeeBPS",
        title: "Set Protocol Fee",
        description: "Protocol fee taken from profit, in basis points (100 = 1%).",
        fields: [{ name: "newFeeBPS", type: "uint", label: "Fee (BPS)", placeholder: "0-10000" }],
      },
      {
        functionName: "setMinProfitThreshold",
        title: "Set Global Min Profit",
        description: "Default minimum net profit (wei) required to execute, unless overridden per asset.",
        fields: [{ name: "newThreshold", type: "uint", label: "Min Profit (wei)", placeholder: "0" }],
      },
      {
        functionName: "setMinSpreadBPS",
        title: "Set Min Spread",
        description: "Minimum gross spread (basis points) required before considering a route.",
        fields: [{ name: "newSpreadBPS", type: "uint", label: "Spread (BPS)", placeholder: "0" }],
      },
    ],
  },
  {
    key: "gas",
    title: "Gas Settings",
    description: "Tune the gas-cost estimate used in net-profit-after-gas calculations.",
    actions: [
      {
        functionName: "setEstimatedGasUnits",
        title: "Set Estimated Gas Units",
        description: "Gas units assumed per arbitrage execution for cost estimation.",
        fields: [{ name: "units", type: "uint", label: "Gas Units", placeholder: "e.g. 500000" }],
      },
    ],
  },
  {
    key: "oracle",
    title: "Oracle Settings",
    description: "Bound how far execution prices may deviate from Chainlink oracle prices, and feed staleness tolerance.",
    actions: [
      {
        functionName: "setMaxOracleDeviationBPS",
        title: "Set Max Oracle Deviation",
        description: "Maximum allowed deviation (BPS) between quoted price and oracle price.",
        fields: [{ name: "newDeviationBPS", type: "uint", label: "Deviation (BPS)", placeholder: "0" }],
      },
      {
        functionName: "setMaxOracleStaleness",
        title: "Set Max Oracle Staleness",
        description: "Maximum age (seconds) of an oracle price update before it's rejected as stale.",
        fields: [{ name: "newStaleness", type: "uint", label: "Staleness (seconds)", placeholder: "3600" }],
      },
    ],
  },
  {
    key: "execution",
    title: "Execution Settings",
    description: "Slippage tolerance, transaction deadline window, and flash-loan size caps.",
    actions: [
      {
        functionName: "setDefaultSlippageBPS",
        title: "Set Default Slippage",
        description: "Default per-hop slippage tolerance (BPS) when the keeper doesn't override it.",
        fields: [{ name: "newSlippageBPS", type: "uint", label: "Slippage (BPS)", placeholder: "50" }],
      },
      {
        functionName: "setDeadlineWindow",
        title: "Set Deadline Window",
        description: "Seconds from submission before a swap's deadline expires.",
        fields: [{ name: "newWindow", type: "uint", label: "Window (seconds)", placeholder: "300" }],
      },
      {
        functionName: "setMaxFlashLoanAmount",
        title: "Set Max Flash Loan Amount",
        description: "Global cap on flash-loan size (wei), independent of per-asset caps.",
        fields: [{ name: "newMax", type: "uint", label: "Max Amount (wei)", placeholder: "0" }],
      },
    ],
  },
  {
    key: "withdrawal",
    title: "Withdrawal Panel",
    description: "Two-step profit withdrawal, and recovery of accidentally-sent tokens/native BNB.",
    actions: [
      {
        functionName: "requestWithdrawal",
        title: "Request Withdrawal",
        description: "Step 1: request a withdrawal of accumulated profit for a token.",
        fields: [
          { name: "token", type: "address", label: "Token Address", placeholder: "0x..." },
          { name: "amount", type: "uint", label: "Amount (wei)", placeholder: "0" },
        ],
      },
      {
        functionName: "executeWithdrawal",
        title: "Execute Withdrawal",
        description: "Step 2: execute a previously requested withdrawal by its request ID.",
        fields: [
          { name: "requestId", type: "bytes32", label: "Request ID", placeholder: "0x..." },
          { name: "token", type: "address", label: "Token Address", placeholder: "0x..." },
          { name: "to", type: "address", label: "Recipient", placeholder: "0x..." },
          { name: "amount", type: "uint", label: "Amount (wei)", placeholder: "0" },
        ],
      },
      {
        functionName: "rescueTokens",
        title: "Rescue Tokens",
        description: "Recover ERC-20 tokens accidentally sent to the contract (not operational funds).",
        fields: [
          { name: "token", type: "address", label: "Token Address", placeholder: "0x..." },
          { name: "to", type: "address", label: "Recipient", placeholder: "0x..." },
          { name: "amount", type: "uint", label: "Amount (wei)", placeholder: "0" },
        ],
      },
      {
        functionName: "rescueNative",
        title: "Rescue Native BNB",
        description: "Recover BNB accidentally sent to the contract.",
        fields: [{ name: "to", type: "address", label: "Recipient", placeholder: "0x..." }],
      },
    ],
  },
  {
    key: "ownership",
    title: "Ownership",
    description: "Two-step ownership transfer (Ownable2Step) - the new owner must explicitly accept.",
    actions: [
      {
        functionName: "transferOwnership",
        title: "Transfer Ownership",
        description: "Nominate a new owner. They must call Accept Ownership to complete the transfer.",
        fields: [{ name: "newOwner", type: "address", label: "New Owner", placeholder: "0x..." }],
        destructive: true,
        confirmText: "Nominate a new owner? This does not take effect until they accept.",
      },
      { functionName: "acceptOwnership", title: "Accept Ownership", description: "Accept a pending ownership transfer (call from the new owner's wallet).", fields: [] },
      {
        functionName: "renounceOwnership",
        title: "Renounce Ownership",
        description: "Permanently remove the owner - no one will be able to call owner-only functions again.",
        fields: [],
        destructive: true,
        confirmText: "This is IRREVERSIBLE. Renounce ownership permanently?",
      },
    ],
  },
];
