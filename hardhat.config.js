import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

function normalizePrivateKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed : null;
}

function buildExternalNetwork(rpcEnvName, chainId, chainType) {
  const rpcUrl = String(process.env[rpcEnvName] || "").trim();
  const deployerKey = normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
  if (!rpcUrl || !deployerKey) return null;
  return {
    type: "http",
    chainType,
    url: rpcUrl,
    chainId,
    accounts: [deployerKey],
  };
}

const networks = {
  localhost: {
    url: "http://127.0.0.1:8545",
  },
};

const sepoliaNet = buildExternalNetwork("SEPOLIA_RPC_URL", 11155111, "l1");
if (sepoliaNet) networks.sepolia = sepoliaNet;

const baseSepoliaNet = buildExternalNetwork("BASE_SEPOLIA_RPC_URL", 84532, "op");
if (baseSepoliaNet) networks.baseSepolia = baseSepoliaNet;

const baseMainnet = buildExternalNetwork("BASE_MAINNET_RPC_URL", 8453, "op");
if (baseMainnet) networks.base = baseMainnet;

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks,
});