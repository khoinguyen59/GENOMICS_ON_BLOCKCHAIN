import React, { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { useWeb3, CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME } from "../../context/Web3Context";
import { useLanguage } from "../../context/LanguageContext";
import { useDatasets } from "../../context/DatasetContext";
import contractAddresses from "../../contracts/contractAddresses.json";
import GenomicZkVerifierABI from "../../contracts/GenomicZkVerifierABI.json";
import GenomicTimelockABI from "../../contracts/GenomicTimelockABI.json";
import { resolveEscrowDispute, queryFilterChunked, getDeploymentStartBlock } from "../../services/datasetService";
import { executeSerializedTx, runWithConcurrency, formatConfiguredChainText } from "../../utils/asyncResilience";
import {
  DataOwnerShieldIcon,
  GenoTokenIcon,
  ShieldCheckIcon,
  CpuChipIcon,
  ServerDriveIcon,
  RefreshSpinIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  WalletKeyIcon,
  CopyIcon
} from "../../components/icons/GenoIcons";

const shortAddr = (addr) =>
  addr && addr.length > 14 ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : addr || "...";

export default function AdminPortal() {
  const {
    account,
    localAccountIndex,
    connectLocalAccount,
    contracts,
    getProviderAndSigner,
    setShowIpfsSettings,
    pinataJwt,
    kuboRpc,
    kuboGateway,
    showToast,
    refreshBalance,
    refreshFaucetPolicy
  } = useWeb3();
  const { fetchOnChainDatasets } = useDatasets();
  const { t, lang } = useLanguage();

  const [loadingTelemetry, setLoadingTelemetry] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [telemetry, setTelemetry] = useState({
    registryOwner: "",
    tokenOwner: "",
    dispatcher: "",
    zkVerifier: "",
    dataCount: 0,
    totalSupplyGeno: 0,
    registryTokenBal: 0,
    bountyCount: 0,
    reuseFeeBps: 500,
    maxBlindTags: 16,
    commitRevealRequired: false,
    faucetEnabled: true,
    faucetVoucherRequired: false,
    faucetSigner: "",
    requireLabAttestation: false,
    chainNowSec: 0,
    isTimelockGoverned: false,
    timelockMinDelay: 0
  });
  const [rpcError, setRpcError] = useState(null);
  const [bounties, setBounties] = useState([]);
  const [timelockAction, setTimelockAction] = useState("setCapsuleDispatcher");
  const [encodedTimelockProposal, setEncodedTimelockProposal] = useState(null);

  // Governance form states
  const [dispatcherInput, setDispatcherInput] = useState("");
  const [zkVerifierInput, setZkVerifierInput] = useState(contractAddresses.GenomicZkVerifier || "");

  // Treasury & Faucet Config form states
  const [mintToInput, setMintToInput] = useState("");
  const [mintAmountInput, setMintAmountInput] = useState("1000");
  const [faucetEnabledInput, setFaucetEnabledInput] = useState(true);
  const [faucetVoucherRequiredInput, setFaucetVoucherRequiredInput] = useState(false);
  const [faucetSignerInput, setFaucetSignerInput] = useState("");
  const [rescueTokenInput, setRescueTokenInput] = useState("");
  const [rescueToInput, setRescueToInput] = useState("");
  const [rescueAmountInput, setRescueAmountInput] = useState("10");

  // ZK Bounty form states
  const [bountyTraitInput, setBountyTraitInput] = useState("ALDH2_rs671");
  const [bountyDescInput, setBountyDescInput] = useState("East Asian ALDH2 rs671 Variant Verification Cohort");
  const [bountyRewardInput, setBountyRewardInput] = useState("50");
  const [bountyMaxClaimsInput, setBountyMaxClaimsInput] = useState("5");
  const [bountyDurationInput, setBountyDurationInput] = useState("86400");
  const defaultLocalDeployer = CONFIGURED_CHAIN_ID === 31337 ? (contractAddresses.Deployer || "") : "";
  const [bountyAttestorInput, setBountyAttestorInput] = useState(
    () => account || defaultLocalDeployer
  );
  const [labAttestorInput, setLabAttestorInput] = useState(
    () => account || defaultLocalDeployer
  );
  const bountyAttestorTouchedRef = useRef(false);
  const labAttestorTouchedRef = useRef(false);

  // Escrow Dispute Arbitration states
  const [disputes, setDisputes] = useState([]);
  const [disputeDataIdInput, setDisputeDataIdInput] = useState("1");
  const [disputeBuyerInput, setDisputeBuyerInput] = useState("");
  const disputeBuyerInputRef = useRef(disputeBuyerInput);
  disputeBuyerInputRef.current = disputeBuyerInput;
  const telemetrySeqRef = useRef(0);

  const loadAdminTelemetry = useCallback(async () => {
    const mySeq = ++telemetrySeqRef.current;
    setLoadingTelemetry(true);
    try {
      const { provider } = await getProviderAndSigner();
      if (telemetrySeqRef.current !== mySeq) return;
      const activeContracts = contracts;
      if (!activeContracts?.registry || !activeContracts?.token) return;

      const latestBlock = await provider?.getBlock?.("latest").catch(() => null);
      const chainNowSec = latestBlock?.timestamp ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      const [
        regOwner,
        tokOwner,
        disp,
        zkAddr,
        dCount,
        totSupply,
        regTokBal,
        reuseBps,
        maxTags,
        commitRevReq,
        fEnabled,
        fVoucherReq,
        fSigner
      ] = await Promise.all([
        activeContracts.registry.owner(),
        activeContracts.token.owner(),
        activeContracts.registry.capsuleDispatcher(),
        activeContracts.registry.zkVerifier(),
        activeContracts.registry.dataCount(),
        activeContracts.token.totalSupply(),
        activeContracts.token.balanceOf(contractAddresses.GenomicsRegistry),
        activeContracts.registry.REUSE_FEE_BPS(),
        activeContracts.registry.MAX_BLIND_TAGS_PER_DATASET(),
        activeContracts.registry.commitRevealRequired?.().catch(() => false),
        activeContracts.token.faucetEnabled?.().catch(() => true),
        activeContracts.token.faucetVoucherRequired?.().catch(() => false),
        activeContracts.token.faucetSigner?.().catch(() => ethers.ZeroAddress)
      ]);

      const activeZkAddr =
        zkAddr && zkAddr !== ethers.ZeroAddress ? zkAddr : contractAddresses.GenomicZkVerifier;

      let isTimelockGoverned = false;
      let timelockMinDelay = 0;
      if (regOwner && regOwner !== ethers.ZeroAddress && provider?.getCode) {
        try {
          const ownerCode = await provider.getCode(regOwner);
          if (ownerCode && ownerCode !== "0x" && ownerCode !== "0x0") {
            const tl = new ethers.Contract(regOwner, GenomicTimelockABI, provider);
            const rawDelay = await tl.getMinDelay().catch(() => null);
            if (rawDelay !== null && rawDelay !== undefined) {
              isTimelockGoverned = true;
              timelockMinDelay = Number(rawDelay);
            }
          }
        } catch {}
      }

      let bCount = 0;
      let reqLabAtt = false;
      const bountyList = [];
      if (activeZkAddr && activeZkAddr !== ethers.ZeroAddress && provider) {
        const zk = new ethers.Contract(activeZkAddr, GenomicZkVerifierABI, provider);
        const [rawBCount, rawReqLabAtt] = await Promise.all([
          zk.bountyCount(),
          zk.requireLabAttestation?.().catch(() => false)
        ]);
        bCount = Number(rawBCount);
        reqLabAtt = Boolean(rawReqLabAtt);
        const bountyIds = Array.from({ length: bCount }, (_, idx) => idx + 1);
        const fetchedBounties = await runWithConcurrency(
          bountyIds,
          async (i) => {
            try {
              const [b, reqAtt] = await Promise.all([
                zk.bounties(i),
                zk.bountyRequiredAttestor?.(i).catch(() => ethers.ZeroAddress)
              ]);
              return {
                bountyId: Number(b.bountyId),
                sponsor: b.sponsor,
                targetTraitId: b.targetTraitId,
                traitDescription: b.traitDescription,
                rewardPerClaim: Number(ethers.formatUnits(b.rewardPerClaim, 18)),
                maxClaims: Number(b.maxClaims),
                currentClaims: Number(b.currentClaims),
                remainingFunding: Number(ethers.formatUnits(b.remainingFunding, 18)),
                expiresAt: Number(b.expiresAt),
                isActive: Boolean(b.isActive),
                isExpired: chainNowSec >= Number(b.expiresAt),
                requiredAttestor: reqAtt && reqAtt !== ethers.ZeroAddress ? reqAtt : null
              };
            } catch {
              return null;
            }
          },
          6
        );
        for (const item of fetchedBounties) {
          if (item) bountyList.push(item);
        }
      }

      if (telemetrySeqRef.current !== mySeq) return;

      setTelemetry({
        registryOwner: regOwner,
        tokenOwner: tokOwner,
        dispatcher: disp,
        zkVerifier: zkAddr,
        dataCount: Number(dCount || 0n),
        totalSupplyGeno: Number(ethers.formatUnits(totSupply || 0n, 18)),
        registryTokenBal: Number(ethers.formatUnits(regTokBal || 0n, 18)),
        bountyCount: bCount,
        reuseFeeBps: Number(reuseBps || 500n),
        maxBlindTags: Number(maxTags || 16n),
        commitRevealRequired: Boolean(commitRevReq),
        faucetEnabled: Boolean(fEnabled),
        faucetVoucherRequired: Boolean(fVoucherReq),
        faucetSigner: fSigner && fSigner !== ethers.ZeroAddress ? fSigner : "",
        requireLabAttestation: reqLabAtt,
        chainNowSec,
        isTimelockGoverned,
        timelockMinDelay
      });
      setFaucetEnabledInput(Boolean(fEnabled));
      setFaucetVoucherRequiredInput(Boolean(fVoucherReq));
      setFaucetSignerInput(fSigner && fSigner !== ethers.ZeroAddress ? fSigner : "");
      const disputeList = [];
      try {
        const dispEvs = await queryFilterChunked(
          activeContracts.registry,
          activeContracts.registry.filters.EscrowDisputed(),
          getDeploymentStartBlock(),
          "latest"
        );
        const seenDisp = new Set();
        const uniqueDisputes = [];
        for (const ev of dispEvs) {
          const dId = Number(ev.args?.dataId || 0);
          const bAddr = ev.args?.buyer;
          const k = `${dId}:${(bAddr || "").toLowerCase()}`;
          if (!dId || !bAddr || seenDisp.has(k)) continue;
          seenDisp.add(k);
          uniqueDisputes.push({ dId, bAddr });
        }
        const hydratedDisputes = await runWithConcurrency(
          uniqueDisputes,
          async ({ dId, bAddr }) => {
            const [isDisp, dep] = await Promise.all([
              activeContracts.registry.escrowDisputed(dId, bAddr).catch(() => false),
              activeContracts.registry.escrowDeposits(dId, bAddr).catch(() => null)
            ]);
            if (isDisp && dep && dep.amount > 0n && !dep.released && !dep.refunded) {
              return {
                dataId: dId,
                buyer: bAddr,
                seller: dep.seller,
                amount: Number(ethers.formatUnits(dep.amount, 18))
              };
            }
            return null;
          },
          6
        );
        for (const item of hydratedDisputes) {
          if (item) disputeList.push(item);
        }
      } catch {}

      if (telemetrySeqRef.current !== mySeq) return;
      setDisputes(disputeList);
      if (disputeList.length > 0 && !disputeBuyerInputRef.current) {
        setDisputeDataIdInput(String(disputeList[0].dataId));
        setDisputeBuyerInput(disputeList[0].buyer);
      }
      setBounties(bountyList);
      const nonZeroDisp = disp && disp !== ethers.ZeroAddress ? disp : "";
      setDispatcherInput((prev) => prev || nonZeroDisp || (!isTimelockGoverned ? regOwner : "") || "");
      setRescueToInput((prev) => prev || account || regOwner || "");
      if (!bountyAttestorTouchedRef.current) {
        setBountyAttestorInput(account || regOwner || defaultLocalDeployer);
      }
      if (!labAttestorTouchedRef.current) {
        setLabAttestorInput(account || regOwner || defaultLocalDeployer);
      }
      setRpcError(null);
    } catch (err) {
      if (telemetrySeqRef.current !== mySeq) return;
      const errMsg = err.shortMessage || err.message;
      setRpcError(errMsg);
      showToast((lang === "vi" ? "Cảnh báo chỉ số Admin: " : "Admin telemetry warning: ") + errMsg, "error");
    } finally {
      if (telemetrySeqRef.current === mySeq) {
        setLoadingTelemetry(false);
      }
    }
  }, [account, contracts, defaultLocalDeployer, getProviderAndSigner, lang, showToast]);

  useEffect(() => {
    loadAdminTelemetry();
  }, [loadAdminTelemetry, account]);

  const requireActiveSigner = async () => {
    const { signer: s } = await getProviderAndSigner();
    if (!s) {
      throw new Error(
        lang === "vi"
          ? "Vui lòng kết nối ví Quản Trị trước."
          : formatConfiguredChainText(
              "Connect Hardhat #0 Admin or wallet signer first.",
              CONFIGURED_CHAIN_ID,
              CONFIGURED_CHAIN_NAME
            )
      );
    }
    return s;
  };

  const handleSetDispatcher = async () => {
    try {
      setBusyAction("dispatcher");
      const trimmedDisp = dispatcherInput.trim();
      if (!ethers.isAddress(trimmedDisp) || trimmedDisp === ethers.ZeroAddress) {
        throw new Error(
          lang === "vi"
            ? "Địa chỉ EVM Dispatcher phải hợp lệ và khác 0x0 (dùng disableCapsuleDispatcher() để vô hiệu hóa)."
            : "Dispatcher EVM address must be valid and non-zero (use disableCapsuleDispatcher() to clear to 0x0)."
        );
      }
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const reg = contracts.registry.connect(s);
      showToast(lang === "vi" ? "Đang gửi giao dịch cập nhật Capsule Dispatcher..." : "Submitting setCapsuleDispatcher transaction...", "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await reg.setCapsuleDispatcher(trimmedDisp);
        await tx.wait();
      });
      showToast(lang === "vi" ? "Đã cập nhật Capsule Dispatcher trên chuỗi!" : "Capsule Dispatcher updated on-chain!");
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật Dispatcher thất bại: " : "setCapsuleDispatcher failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleToggleCommitReveal = async () => {
    try {
      setBusyAction("commitreveal");
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const reg = contracts.registry.connect(s);
      const nextVal = !telemetry.commitRevealRequired;
      showToast(
        lang === "vi"
          ? `Đang cập nhật chế độ Commit-Reveal: ${nextVal ? "BẬT" : "TẮT"}...`
          : `Updating Commit-Reveal front-running guard: ${nextVal ? "ENABLED" : "DISABLED"}...`,
        "info"
      );
      await executeSerializedTx(txAccount, async () => {
        const tx = await reg.setCommitRevealRequired(nextVal);
        await tx.wait();
      });
      showToast(
        lang === "vi"
          ? `Chế độ Commit-Reveal đã chuyển sang: ${nextVal ? "BẬT" : "TẮT"}!`
          : `Commit-Reveal mode updated to: ${nextVal ? "ENABLED" : "DISABLED"}!`
      );
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật Commit-Reveal thất bại: " : "setCommitRevealRequired failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleSetZkVerifier = async () => {
    try {
      setBusyAction("zkverifier");
      if (!ethers.isAddress(zkVerifierInput)) throw new Error(lang === "vi" ? "Địa chỉ EVM ZK Verifier không hợp lệ." : "Invalid ZK Verifier EVM address.");
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const reg = contracts.registry.connect(s);
      showToast(lang === "vi" ? "Đang gửi giao dịch liên kết ZK Verifier..." : "Submitting setZkVerifier transaction...", "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await reg.setZkVerifier(zkVerifierInput);
        await tx.wait();
      });
      showToast(lang === "vi" ? "Đã liên kết hợp đồng ZK Verifier trên chuỗi!" : "ZK Verifier linked on-chain!");
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Liên kết ZK Verifier thất bại: " : "setZkVerifier failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleMintGeno = async () => {
    try {
      setBusyAction("mint");
      if (!ethers.isAddress(mintToInput)) throw new Error(lang === "vi" ? "Địa chỉ ví nhận không hợp lệ." : "Invalid recipient EVM address.");
      const trimmedAmt = String(mintAmountInput ?? "").trim();
      if (!/^\d+(\.\d{1,18})?$/.test(trimmedAmt)) {
        throw new Error(
          lang === "vi"
            ? "Số lượng Mint phải là số thập phân dương hợp lệ (tối đa 18 chữ số thập phân)."
            : "Mint amount must be a valid positive decimal number (up to 18 decimals)."
        );
      }
      const mintWei = ethers.parseUnits(trimmedAmt, 18);
      if (mintWei <= 0n) throw new Error(lang === "vi" ? "Số lượng Mint phải lớn hơn 0." : "Mint amount must be > 0.");
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const tok = contracts.token.connect(s);
      showToast(lang === "vi" ? `Đang phát hành ${trimmedAmt} $GENO tới ${mintToInput.slice(0, 8)}...` : `Minting ${trimmedAmt} $GENO to ${mintToInput.slice(0, 8)}...`, "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await tok.mint(mintToInput, mintWei);
        await tx.wait();
      });
      showToast(lang === "vi" ? `Đã phát hành ${trimmedAmt} $GENO thành công!` : `Minted ${trimmedAmt} $GENO successfully!`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Phát hành thất bại: " : "Mint failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleRescueTokens = async () => {
    try {
      setBusyAction("rescue");
      if (!ethers.isAddress(rescueTokenInput) || !ethers.isAddress(rescueToInput)) {
        throw new Error(lang === "vi" ? "Địa chỉ token ngoại lai hoặc địa chỉ nhận không hợp lệ." : "Invalid token or recipient EVM address.");
      }
      const trimmedAmt = String(rescueAmountInput ?? "").trim();
      if (!/^\d+(\.\d+)?$/.test(trimmedAmt)) {
        throw new Error(
          lang === "vi"
            ? "Số lượng thu hồi phải là số thập phân dương hợp lệ."
            : "Rescue amount must be a valid positive decimal number."
        );
      }
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const erc20 = new ethers.Contract(rescueTokenInput, ["function decimals() view returns (uint8)"], s);
      let decimals = 18;
      try {
        const rawDec = Number(await erc20.decimals());
        if (Number.isInteger(rawDec) && rawDec >= 0 && rawDec <= 36) {
          decimals = rawDec;
        }
      } catch {
        decimals = 18;
      }
      const fracPart = trimmedAmt.includes(".") ? trimmedAmt.split(".")[1] : "";
      if (fracPart.length > decimals) {
        throw new Error(
          lang === "vi"
            ? `Token này chỉ hỗ trợ tối đa ${decimals} chữ số thập phân.`
            : `Target ERC-20 token supports at most ${decimals} decimal places.`
        );
      }
      const rescueWei = ethers.parseUnits(trimmedAmt, decimals);
      if (rescueWei <= 0n) throw new Error(lang === "vi" ? "Số lượng thu hồi phải lớn hơn 0." : "Rescue amount must be > 0.");
      const reg = contracts.registry.connect(s);
      showToast(lang === "vi" ? `Đang thu hồi ${trimmedAmt} token ngoại lai (decimals=${decimals})...` : `Rescuing ${trimmedAmt} tokens (decimals=${decimals}) from Registry...`, "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await reg.rescueTokens(rescueTokenInput, rescueToInput, rescueWei);
        await tx.wait();
      });
      showToast(lang === "vi" ? `Đã thu hồi ${trimmedAmt} token thành công!` : `Rescued ${trimmedAmt} tokens successfully!`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Thu hồi token thất bại: " : "rescueTokens failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const computedTraitId = /^0x[0-9a-fA-F]{64}$/.test(bountyTraitInput.trim())
    ? bountyTraitInput.trim()
    : ethers.id(bountyTraitInput.trim() || "ALDH2_rs671");

  const handleCreateZkBounty = async () => {
    try {
      setBusyAction("bounty-create");
      const trimmedReward = String(bountyRewardInput ?? "").trim();
      const trimmedMaxClaims = String(bountyMaxClaimsInput ?? "").trim();
      const trimmedDur = String(bountyDurationInput ?? "").trim();
      const maxClaims = /^\d+$/.test(trimmedMaxClaims) ? Number(trimmedMaxClaims) : NaN;
      const dur = /^\d+$/.test(trimmedDur) ? Number(trimmedDur) : NaN;
      if (!/^\d+(\.\d{1,18})?$/.test(trimmedReward)) {
        throw new Error(
          lang === "vi"
            ? "Mức thưởng mỗi lượt phải là số thập phân dương hợp lệ (tối đa 18 chữ số thập phân)."
            : "Reward per claim must be a valid positive decimal number (up to 18 decimals)."
        );
      }
      const rewardWei = ethers.parseUnits(trimmedReward, 18);
      if (rewardWei < 10n ** 18n) {
        throw new Error(lang === "vi" ? "Mức thưởng mỗi lượt phải >= 1 $GENO (MIN_BOUNTY_REWARD)." : "Reward per claim must be >= 1 $GENO (MIN_BOUNTY_REWARD).");
      }
      if (!Number.isSafeInteger(maxClaims) || maxClaims < 1) throw new Error(lang === "vi" ? "Số lượt tối đa phải là số nguyên >= 1." : "Max claims must be an integer >= 1.");
      if (!Number.isSafeInteger(dur) || dur < 3600 || dur > 31536000) {
        throw new Error(lang === "vi" ? "Thời hạn phải là số nguyên từ 3600 đến 31536000 giây (1 giờ - 365 ngày)." : "Duration must be an integer between 3600 and 31536000 seconds (1h - 365d).");
      }

      const trimmedAttestor = bountyAttestorInput.trim();
      if (!trimmedAttestor && telemetry.requireLabAttestation) {
        throw new Error(
          lang === "vi"
            ? "Chế độ bảo mật requireLabAttestation đang BẬT: bắt buộc nhập địa chỉ Phòng Lab xác thực được phê duyệt (0x...)."
            : "Production requireLabAttestation policy is ENABLED: an approved sequencing-lab attestor address (0x...) is required."
        );
      }
      if (trimmedAttestor && (!ethers.isAddress(trimmedAttestor) || trimmedAttestor === ethers.ZeroAddress)) {
        throw new Error(lang === "vi" ? "Địa chỉ Phòng Lab xác thực (Attestor) không hợp lệ." : "Invalid lab attestor EVM address.");
      }

      const s = await requireActiveSigner();
      const activeAddr = await s.getAddress();
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);

      const liveRequireLab = await zk.requireLabAttestation().catch(() => Boolean(telemetry.requireLabAttestation));
      if (!trimmedAttestor && liveRequireLab) {
        throw new Error(
          lang === "vi"
            ? "Chế độ bảo mật requireLabAttestation đang BẬT: bắt buộc nhập địa chỉ Phòng Lab xác thực được phê duyệt (0x...)."
            : "Production requireLabAttestation policy is ENABLED: an approved sequencing-lab attestor address (0x...) is required."
        );
      }
      if (trimmedAttestor && liveRequireLab) {
        const isApproved = await zk.approvedLabAttestors(trimmedAttestor).catch(() => false);
        if (!isApproved) {
          throw new Error(
            lang === "vi"
              ? "Địa chỉ Phòng Lab xác thực (Attestor) chưa được phê duyệt trên GenomicZkVerifier."
              : "Lab attestor address is not approved on GenomicZkVerifier."
          );
        }
      }

      const totalFundingWei = rewardWei * BigInt(maxClaims);
      const tok = contracts.token.connect(s);
      await executeSerializedTx(account || activeAddr, async () => {
        const allowance = await tok.allowance(activeAddr, targetZkAddr);
        if (allowance < totalFundingWei) {
          showToast(lang === "vi" ? "1/2: Đang phê duyệt ngân sách $GENO cho GenomicZkVerifier..." : "1/2: Approving $GENO funding for GenomicZkVerifier...", "info");
          const approveTx = await tok.approve(targetZkAddr, totalFundingWei);
          await approveTx.wait();
        }

        let tx;
        if (trimmedAttestor) {
          showToast(lang === "vi" ? "2/2: Đang khởi tạo Quỹ Thưởng ZK Xác Thực Phòng Lab trên chuỗi..." : "2/2: Creating Certified Lab-Attested ZK Bounty on-chain...", "info");
          tx = await zk.createAttestedZkBounty(
            computedTraitId,
            bountyDescInput.trim() || "Certified Lab-Attested Genomic Trait Cohort",
            rewardWei,
            maxClaims,
            dur,
            trimmedAttestor
          );
        } else {
          showToast(lang === "vi" ? "2/2: Đang khởi tạo Quỹ Thưởng Đặc Tính ZK trên chuỗi..." : "2/2: Creating on-chain ZK Trait Verification Bounty...", "info");
          tx = await zk.createZkBounty(
            computedTraitId,
            bountyDescInput.trim() || "Verified Genomic Trait Cohort",
            rewardWei,
            maxClaims,
            dur
          );
        }
        await tx.wait();
      });
      showToast(lang === "vi" ? "Đã khởi tạo và nạp ngân sách Quỹ Thưởng ZK trên chuỗi!" : "ZK Trait Bounty created and funded on-chain!");
      await refreshBalance(account);
      await fetchOnChainDatasets(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Tạo quỹ thưởng ZK thất bại: " : "createZkBounty failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleSetFaucetConfig = async () => {
    try {
      setBusyAction("faucet-config");
      const trimmedSigner = faucetSignerInput.trim();
      if (trimmedSigner && !ethers.isAddress(trimmedSigner)) {
        throw new Error(lang === "vi" ? "Địa chỉ EVM Faucet Signer không hợp lệ." : "Invalid faucet signer EVM address.");
      }
      if (faucetVoucherRequiredInput && (!trimmedSigner || trimmedSigner === ethers.ZeroAddress)) {
        throw new Error(lang === "vi" ? "Chế độ Voucher ECDSA yêu cầu địa chỉ Signer hợp lệ khác 0x0." : "Voucher-gated mode requires a valid non-zero faucet signer EVM address.");
      }
      const targetSigner = trimmedSigner || ethers.ZeroAddress;
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const tok = contracts.token.connect(s);
      showToast(lang === "vi" ? "Đang cập nhật cấu hình Faucet trên chuỗi..." : "Updating on-chain Faucet policy...", "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await tok.setFaucetConfig(Boolean(faucetEnabledInput), Boolean(faucetVoucherRequiredInput), targetSigner);
        await tx.wait();
      });
      showToast(lang === "vi" ? "Đã cập nhật chính sách Faucet thành công!" : "Faucet configuration updated on-chain!");
      await refreshFaucetPolicy?.(contracts.token);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật Faucet thất bại: " : "setFaucetConfig failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleToggleRequireLabAttestation = async () => {
    try {
      setBusyAction("zk-req-attest");
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      const nextVal = !telemetry.requireLabAttestation;
      showToast(
        lang === "vi"
          ? `Đang cập nhật yêu cầu chứng thực phòng Lab ZK: ${nextVal ? "BẬT" : "TẮT"}...`
          : `Updating ZK requireLabAttestation policy: ${nextVal ? "ENABLED" : "DISABLED"}...`,
        "info"
      );
      await executeSerializedTx(txAccount, async () => {
        const tx = await zk.setRequireLabAttestation(nextVal);
        await tx.wait();
      });
      showToast(
        lang === "vi"
          ? `Chính sách chứng thực Lab ZK đã chuyển sang: ${nextVal ? "BẬT" : "TẮT"}!`
          : `ZK requireLabAttestation policy updated to: ${nextVal ? "ENABLED" : "DISABLED"}!`
      );
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật chứng thực Lab thất bại: " : "setRequireLabAttestation failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleSetApprovedLabAttestor = async (approved) => {
    try {
      setBusyAction(approved ? "zk-lab-approve" : "zk-lab-revoke");
      const trimmedLab = labAttestorInput.trim();
      if (!ethers.isAddress(trimmedLab) || trimmedLab === ethers.ZeroAddress) {
        throw new Error(lang === "vi" ? "Địa chỉ Phòng Lab EVM không hợp lệ." : "Invalid clinical lab attestor EVM address.");
      }
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast(
        lang === "vi"
          ? `Đang ${approved ? "phê duyệt" : "thu hồi"} phòng Lab ${shortAddr(trimmedLab)}...`
          : `${approved ? "Approving" : "Revoking"} clinical lab attestor ${shortAddr(trimmedLab)}...`,
        "info"
      );
      await executeSerializedTx(txAccount, async () => {
        const tx = await zk.setApprovedLabAttestor(trimmedLab, Boolean(approved));
        await tx.wait();
      });
      showToast(
        lang === "vi"
          ? `Đã ${approved ? "phê duyệt" : "thu hồi"} phòng Lab ${shortAddr(trimmedLab)} trên chuỗi!`
          : `Clinical lab attestor ${shortAddr(trimmedLab)} ${approved ? "approved" : "revoked"} on-chain!`
      );
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Cập nhật phòng Lab thất bại: " : "setApprovedLabAttestor failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handlePruneExpiredBounties = async () => {
    try {
      setBusyAction("zk-prune");
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast(
        lang === "vi"
          ? "Đang dọn tối đa 64 slot quỹ ZK hết hạn trên chuỗi..."
          : "Pruning up to 64 expired ZK bounty slots on-chain...",
        "info"
      );
      await executeSerializedTx(txAccount, async () => {
        const tx = await zk.pruneExpiredBounties(64);
        await tx.wait();
      });
      showToast(
        lang === "vi"
          ? "Đã hoàn tất dọn dẹp theo lô quỹ ZK hết hạn!"
          : "Bounded expired ZK bounty cleanup completed!"
      );
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Dọn quỹ ZK hết hạn thất bại: " : "pruneExpiredBounties failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleEmergencyCancelBounty = async (bountyId) => {
    try {
      setBusyAction(`cancel-${bountyId}`);
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast(lang === "vi" ? `Đang hủy khẩn cấp Quỹ ZK #${bountyId} & hoàn 100% ngân sách dư...` : `Emergency cancelling ZK Bounty #${bountyId}...`, "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await zk.emergencyCancelBounty(bountyId);
        await tx.wait();
      });
      showToast(lang === "vi" ? `Đã hủy khẩn cấp Quỹ ZK #${bountyId} và hoàn trả ngân sách còn dư.` : `Emergency cancelled Bounty #${bountyId} and refunded remaining $GENO.`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Hủy khẩn cấp quỹ ZK thất bại: " : "emergencyCancelBounty failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleCloseBounty = async (bountyId) => {
    try {
      setBusyAction(`close-${bountyId}`);
      const s = await requireActiveSigner();
      const txAccount = account || (await s.getAddress());
      const targetZkAddr =
        telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
          ? telemetry.zkVerifier
          : contractAddresses.GenomicZkVerifier;
      const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, s);
      showToast(lang === "vi" ? `Đang đóng Quỹ Thưởng ZK hết hạn #${bountyId}...` : `Closing expired ZK Bounty #${bountyId}...`, "info");
      await executeSerializedTx(txAccount, async () => {
        const tx = await zk.closeExpiredBounty(bountyId);
        await tx.wait();
      });
      showToast(lang === "vi" ? `Đã đóng Quỹ ZK #${bountyId} và hoàn trả ngân sách còn dư.` : `Closed Bounty #${bountyId} and refunded remaining $GENO.`);
      await refreshBalance(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Đóng quỹ ZK thất bại: " : "closeExpiredBounty failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const handleResolveDispute = async (targetDataId, targetBuyer, refundBuyer) => {
    try {
      setBusyAction(`dispute-${refundBuyer ? "refund" : "release"}`);
      const rawIdStr = String(targetDataId ?? disputeDataIdInput ?? "").trim();
      if (!/^\d+$/.test(rawIdStr)) throw new Error(lang === "vi" ? "Mã dữ liệu không hợp lệ." : "Invalid Dataset ID.");
      const dId = Number(rawIdStr);
      const buyerAddr = (targetBuyer ?? disputeBuyerInput).trim();
      if (!Number.isSafeInteger(dId) || dId <= 0) throw new Error(lang === "vi" ? "Mã dữ liệu không hợp lệ." : "Invalid Dataset ID.");
      if (!ethers.isAddress(buyerAddr)) throw new Error(lang === "vi" ? "Địa chỉ người mua khiếu nại không hợp lệ." : "Invalid disputing buyer EVM address.");
      const s = await requireActiveSigner();
      showToast(
        lang === "vi"
          ? refundBuyer
            ? `Đang phân xử tranh chấp #${dId}: Hoàn tiền 100% cho người mua...`
            : `Đang phân xử tranh chấp #${dId}: Bác khiếu nại & giải ngân cho người bán...`
          : refundBuyer
            ? `Resolving dispute #${dId}: Refunding 100% to buyer...`
            : `Resolving dispute #${dId}: Rejecting dispute & releasing funds to seller...`,
        "info"
      );
      await resolveEscrowDispute({ dataId: dId, buyer: buyerAddr, refundBuyer, signer: s });
      showToast(
        lang === "vi"
          ? refundBuyer
            ? `Đã phân xử tranh chấp #${dId}: Hoàn tiền 100% cho người mua.`
            : `Đã phân xử tranh chấp #${dId}: Giải ngân cho người bán & tác giả EIP-2981.`
          : refundBuyer
            ? `Dispute #${dId} resolved: Buyer refunded 100%.`
            : `Dispute #${dId} resolved: Escrow released to seller + EIP-2981 creator.`
      );
      await refreshBalance(account);
      await fetchOnChainDatasets(account);
      await loadAdminTelemetry();
    } catch (err) {
      showToast((lang === "vi" ? "Phân xử tranh chấp thất bại: " : "resolveEscrowDispute failed: ") + (err.shortMessage || err.message), "error");
    } finally {
      setBusyAction("");
    }
  };

  const isOwnerMatch =
    account &&
    telemetry.registryOwner &&
    account.toLowerCase() === telemetry.registryOwner.toLowerCase();

  const handleEncodeTimelockProposal = () => {
    try {
      const timelockAddr = telemetry.registryOwner || contractAddresses.GenomicTimelock;
      if (!ethers.isAddress(timelockAddr)) {
        throw new Error(lang === "vi" ? "Không tìm thấy địa chỉ GenomicTimelock." : "GenomicTimelock address unavailable.");
      }
      const timelockIface = new ethers.Interface(GenomicTimelockABI);
      const regIface = contracts?.registry?.interface || new ethers.Interface([
        "function setCapsuleDispatcher(address newDispatcher)",
        "function disableCapsuleDispatcher()",
        "function setCommitRevealRequired(bool required)",
        "function setZkVerifier(address newVerifier)"
      ]);
      const tokIface = contracts?.token?.interface || new ethers.Interface([
        "function setFaucetConfig(bool enabled, bool voucherRequired, address signerAddr)"
      ]);
      const zkIface = new ethers.Interface(GenomicZkVerifierABI);

      let target = contracts?.registry?.target || contractAddresses.GenomicsRegistry;
      let innerCalldata = "0x";
      if (timelockAction === "setCapsuleDispatcher") {
        const trimmedDisp = dispatcherInput.trim();
        if (!ethers.isAddress(trimmedDisp) || trimmedDisp === ethers.ZeroAddress) {
          throw new Error(
            lang === "vi"
              ? "Địa chỉ EVM Dispatcher phải hợp lệ và khác 0x0 (chọn disableCapsuleDispatcher() để tắt về 0x0)."
              : "Invalid or zero dispatcher EVM address (select disableCapsuleDispatcher() to clear to 0x0)."
          );
        }
        innerCalldata = regIface.encodeFunctionData("setCapsuleDispatcher", [trimmedDisp]);
      } else if (timelockAction === "disableCapsuleDispatcher") {
        innerCalldata = regIface.encodeFunctionData("disableCapsuleDispatcher", []);
      } else if (timelockAction === "setCommitRevealRequired") {
        innerCalldata = regIface.encodeFunctionData("setCommitRevealRequired", [!telemetry.commitRevealRequired]);
      } else if (timelockAction === "setZkVerifier") {
        const trimmedZk = zkVerifierInput.trim();
        if (!ethers.isAddress(trimmedZk) || trimmedZk === ethers.ZeroAddress) {
          throw new Error(lang === "vi" ? "Địa chỉ EVM ZK Verifier phải hợp lệ và khác 0x0." : "Invalid or zero ZK Verifier EVM address.");
        }
        innerCalldata = regIface.encodeFunctionData("setZkVerifier", [trimmedZk]);
      } else if (timelockAction === "setFaucetConfig") {
        const trimmedSigner = faucetSignerInput.trim();
        if (trimmedSigner && !ethers.isAddress(trimmedSigner)) {
          throw new Error(lang === "vi" ? "Địa chỉ EVM signer voucher không hợp lệ." : "Invalid faucet voucher signer EVM address.");
        }
        if (faucetVoucherRequiredInput && (!trimmedSigner || trimmedSigner === ethers.ZeroAddress)) {
          throw new Error(lang === "vi" ? "Cần địa chỉ signer voucher hợp lệ khác 0x0." : "Valid non-zero faucet voucher signer address required.");
        }
        target = contracts?.token?.target || contractAddresses.GenomicToken;
        innerCalldata = tokIface.encodeFunctionData("setFaucetConfig", [
          Boolean(faucetEnabledInput),
          Boolean(faucetVoucherRequiredInput),
          trimmedSigner || ethers.ZeroAddress
        ]);
      } else if (timelockAction === "setRequireLabAttestation") {
        target =
          telemetry.zkVerifier && telemetry.zkVerifier !== ethers.ZeroAddress
            ? telemetry.zkVerifier
            : contractAddresses.GenomicZkVerifier;
        innerCalldata = zkIface.encodeFunctionData("setRequireLabAttestation", [!telemetry.requireLabAttestation]);
      }
      const salt = ethers.id(`GENOCHAIN_TIMELOCK_PROPOSAL_${timelockAction}_${Math.floor(Date.now() / 1000)}`);
      const delayBig = BigInt(telemetry.timelockMinDelay || 0);
      const scheduleCalldata = timelockIface.encodeFunctionData("schedule", [
        target,
        0n,
        innerCalldata,
        ethers.ZeroHash,
        salt,
        delayBig
      ]);
      const executeCalldata = timelockIface.encodeFunctionData("execute", [
        target,
        0n,
        innerCalldata,
        ethers.ZeroHash,
        salt
      ]);
      setEncodedTimelockProposal({
        timelock: timelockAddr,
        target,
        action: timelockAction,
        delaySec: Number(delayBig),
        salt,
        scheduleCalldata,
        executeCalldata
      });
      showToast(
        lang === "vi"
          ? "Đã tạo calldata GenomicTimelock.schedule(...)!"
          : "Encoded GenomicTimelock.schedule(...) calldata!"
      );
    } catch (err) {
      showToast((lang === "vi" ? "Mã hóa đề xuất thất bại: " : "Timelock encode failed: ") + (err.shortMessage || err.message), "error");
    }
  };

  const isLocalDevHost =
    import.meta.env.DEV ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"));

  const copyAddr = (val) => {
    if (!val || !navigator.clipboard?.writeText) return;
    Promise.resolve(navigator.clipboard.writeText(val))
      .then(() => {
        showToast(t("copiedToast") || (lang === "vi" ? "Đã sao chép!" : "Copied!"));
      })
      .catch(() => {
        showToast(lang === "vi" ? "Không có quyền ghi bộ nhớ tạm." : "Clipboard permission denied.", "error");
      });
  };

  return (
    <div>
      {/* Top Admin Governance Header & Quick Role Switcher */}
      <div className="portal-subnav-bar" style={{ flexWrap: "wrap", gap: "12px" }}>
        <div className="admin-subnav-controls">
          {isLocalDevHost && CONFIGURED_CHAIN_ID === 31337 && (
            <>
              <span className="admin-subnav-label">
                {formatConfiguredChainText(t("adminQuickAccounts"), CONFIGURED_CHAIN_ID, CONFIGURED_CHAIN_NAME)}:
              </span>
              <span className="admin-acct-group">
                <button
                  id="admin-switch-acct-0"
                  type="button"
                  className={`btn-terminal ${localAccountIndex === 0 ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                  style={{ padding: "5px 10px", fontSize: "12px" }}
                  title={t("adminAcct0")}
                  onClick={() => connectLocalAccount(0)}
                >
                  <WalletKeyIcon size={13} />
                  <span>{t("adminAcct0")}</span>
                </button>
                <button
                  id="admin-switch-acct-1"
                  type="button"
                  className={`btn-terminal ${localAccountIndex === 1 ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                  style={{ padding: "5px 10px", fontSize: "12px" }}
                  title={t("adminAcct1")}
                  onClick={() => connectLocalAccount(1)}
                >
                  <DataOwnerShieldIcon size={13} />
                  <span>{t("adminAcct1")}</span>
                </button>
                <button
                  id="admin-switch-acct-2"
                  type="button"
                  className={`btn-terminal ${localAccountIndex === 2 ? "btn-terminal-primary" : "btn-terminal-ghost"}`}
                  style={{ padding: "5px 10px", fontSize: "12px" }}
                  title={t("adminAcct2")}
                  onClick={() => connectLocalAccount(2)}
                >
                  <CpuChipIcon size={13} />
                  <span>{t("adminAcct2")}</span>
                </button>
              </span>
              <span className="admin-subnav-sep" aria-hidden="true" />
            </>
          )}
          <button
            id="admin-open-ipfs-btn"
            type="button"
            className="btn-terminal btn-terminal-ghost"
            style={{ padding: "5px 10px", fontSize: "12px" }}
            title={t("adminOpenIpfs")}
            onClick={() => setShowIpfsSettings(true)}
          >
            <ServerDriveIcon size={13} />
            <span>{t("adminOpenIpfs")}</span>
          </button>
          <button
            id="admin-refresh-telemetry-btn"
            type="button"
            className="btn-terminal btn-terminal-ghost"
            style={{ padding: "5px 10px", fontSize: "12px" }}
            title={t("adminRefreshTelemetry")}
            onClick={loadAdminTelemetry}
          >
            <RefreshSpinIcon size={13} />
            <span>{loadingTelemetry ? "..." : t("adminRefreshTelemetry")}</span>
          </button>
        </div>

        <div className="portal-role-badge-static">
          <ShieldCheckIcon size={14} color={isOwnerMatch ? "#10b981" : "#f59e0b"} />
          <span>{t("roleAdminBadge")}</span>
        </div>
      </div>

      {/* Clear Page Heading & Subtitle */}
      <div className="admin-header-row">
        <div>
          <h1 className="admin-page-title">{t("adminPageTitle")}</h1>
          <p className="admin-portal-subtitle">{t("adminPortalSubtitle")}</p>
        </div>
      </div>

      {/* Persistent Inline RPC Error Banner */}
      {rpcError && (
        <div
          id="admin-rpc-error-banner"
          className="admin-rpc-error-banner"
          role="alert"
          style={{
            marginBottom: "18px",
            padding: "14px 18px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.45)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            flexWrap: "wrap"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <AlertTriangleIcon size={20} color="var(--accent-rose-text)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: "13px", color: "var(--accent-rose-text)" }}>
                {t("rpcOfflineTitle") || "Mất kết nối Node RPC Blockchain"}
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                {formatConfiguredChainText(
                  t("rpcOfflineDesc") || "Chỉ số hệ thống hiển thị trạng thái ngắt kết nối. Vui lòng kiểm tra kết nối RPC.",
                  CONFIGURED_CHAIN_ID,
                  CONFIGURED_CHAIN_NAME
                )} ({rpcError})
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-terminal btn-terminal-primary"
            style={{ height: "32px", fontSize: "12px", padding: "0 14px", whiteSpace: "nowrap" }}
            onClick={loadAdminTelemetry}
          >
            <RefreshSpinIcon size={13} />
            <span>{t("retryConnection") || "Thử lại kết nối RPC"}</span>
          </button>
        </div>
      )}

      {/* Timelock Governance Mode Banner & Proposal Calldata Encoder */}
      {telemetry.isTimelockGoverned && (
        <section
          id="admin-timelock-mode-banner"
          className="studio-panel"
          style={{ marginBottom: "18px", borderColor: "var(--accent-cyan)" }}
        >
          <div className="panel-title-bar" style={{ marginBottom: "10px" }}>
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <ShieldCheckIcon size={16} color="var(--accent-cyan)" />
              </span>
              {t("adminTimelockBannerTitle")}
            </h2>
            <span className="admin-owner-pill is-match">
              <CheckCircleIcon size={12} />
              <span>
                {t("adminTimelockMinDelayLabel")}: {telemetry.timelockMinDelay}s
              </span>
            </span>
          </div>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", margin: "0 0 12px 0" }}>
            {t("adminTimelockBannerDesc")} ({shortAddr(telemetry.registryOwner)})
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <select
              id="admin-timelock-action-select"
              aria-label={t("adminTimelockActionLabel")}
              className="field-input"
              style={{ flex: "1 1 220px", maxWidth: "340px" }}
              value={timelockAction}
              onChange={(e) => setTimelockAction(e.target.value)}
            >
              <option value="setCapsuleDispatcher">setCapsuleDispatcher(address)</option>
              <option value="disableCapsuleDispatcher">disableCapsuleDispatcher()</option>
              <option value="setCommitRevealRequired">setCommitRevealRequired(bool)</option>
              <option value="setZkVerifier">setZkVerifier(address)</option>
              <option value="setFaucetConfig">setFaucetConfig(bool,bool,address)</option>
              <option value="setRequireLabAttestation">setRequireLabAttestation(bool)</option>
            </select>
            <button
              id="admin-timelock-encode-btn"
              type="button"
              className="btn-terminal btn-terminal-primary"
              title={t("adminTimelockEncodeBtn")}
              onClick={handleEncodeTimelockProposal}
            >
              <span>{t("adminTimelockEncodeBtn")}</span>
            </button>
            {encodedTimelockProposal && (
              <>
                <button
                  id="admin-timelock-copy-btn"
                  type="button"
                  className="btn-terminal btn-terminal-success"
                  title={t("adminTimelockCopyBtn")}
                  onClick={() => copyAddr(encodedTimelockProposal.scheduleCalldata)}
                >
                  <CopyIcon size={12} />
                  <span>{t("adminTimelockCopyBtn")}</span>
                </button>
                <button
                  id="admin-timelock-copy-exec-btn"
                  type="button"
                  className="btn-terminal btn-terminal-ghost"
                  title={t("adminTimelockCopyExecBtn")}
                  onClick={() => copyAddr(encodedTimelockProposal.executeCalldata)}
                >
                  <CopyIcon size={12} />
                  <span>{t("adminTimelockCopyExecBtn")}</span>
                </button>
              </>
            )}
          </div>
          {encodedTimelockProposal && (
            <div style={{ marginTop: "10px", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}>
              <div style={{ color: "var(--text-secondary)", marginBottom: "4px" }}>
                <strong>{t("adminTimelockEncodedLabel")}</strong> | target: {shortAddr(encodedTimelockProposal.target)} | delay: {encodedTimelockProposal.delaySec}s | salt: {shortAddr(encodedTimelockProposal.salt)}
              </div>
              <textarea
                id="admin-timelock-calldata-output"
                aria-label={t("adminTimelockEncodedLabel")}
                readOnly
                rows={2}
                className="field-input"
                style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                value={encodedTimelockProposal.scheduleCalldata}
              />
            </div>
          )}
        </section>
      )}

      {/* 2x2 Admin Governance Studio Grid */}
      <div className="admin-governance-grid">
        {/* CARD 1: Protocol Telemetry & IPFS Configuration */}
        <section id="admin-telemetry-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <ServerDriveIcon size={16} color="var(--accent-cyan)" />
              </span>
              {t("adminTelemetryTitle")}
            </h2>
            <span className={`admin-owner-pill ${isOwnerMatch || telemetry.isTimelockGoverned ? "is-match" : "is-mismatch"}`}>
              {isOwnerMatch || telemetry.isTimelockGoverned ? <CheckCircleIcon size={12} /> : <AlertTriangleIcon size={12} />}
              <span>
                {telemetry.isTimelockGoverned
                  ? t("adminOwnerTimelock")
                  : isOwnerMatch
                    ? t("adminOwnerMatch")
                    : t("adminOwnerMismatch")}
              </span>
            </span>
          </div>

          <div className="admin-kpi-grid">
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiDatasets")}</div>
              <div className="admin-kpi-val">
                {rpcError ? "RPC Offline" : `${telemetry.dataCount} / ${telemetry.bountyCount}`}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiSupply")}</div>
              <div className="admin-kpi-val is-accent">
                {rpcError ? "RPC Offline" : telemetry.totalSupplyGeno.toLocaleString()}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiRoyalty")}</div>
              <div className="admin-kpi-val" style={{ fontSize: "15px" }}>
                {rpcError ? "RPC Offline" : `${telemetry.reuseFeeBps / 100}% (${telemetry.reuseFeeBps} bps) / ${telemetry.maxBlindTags}`}
              </div>
            </div>
            <div className="admin-kpi-tile">
              <div className="admin-kpi-label">{t("adminKpiEscrow")}</div>
              <div className="admin-kpi-val is-emerald" style={{ fontSize: "15px" }}>
                {rpcError ? "RPC Offline" : `${telemetry.registryTokenBal.toLocaleString()} $GENO`}
              </div>
            </div>
          </div>

          <div className="admin-kv-table">
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminRegistryOwner")}</span>
              <span className="admin-kv-val" title={telemetry.registryOwner}>
                <span>{shortAddr(telemetry.registryOwner)}</span>
                {telemetry.registryOwner && (
                  <button type="button" className="admin-copy-btn" title={telemetry.registryOwner} onClick={() => copyAddr(telemetry.registryOwner)}>
                    <CopyIcon size={11} />
                  </button>
                )}
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminConnectedSigner")}</span>
              <span className="admin-kv-val" title={account || ""}>
                <span>{account ? shortAddr(account) : t("adminSignerDisconnected")}</span>
                {account && (
                  <button type="button" className="admin-copy-btn" title={account} onClick={() => copyAddr(account)}>
                    <CopyIcon size={11} />
                  </button>
                )}
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelDispatcher")}</span>
              <span className="admin-kv-val" title={telemetry.dispatcher || ethers.ZeroAddress}>
                <span>{shortAddr(telemetry.dispatcher || ethers.ZeroAddress)}</span>
                <button type="button" className="admin-copy-btn" title={telemetry.dispatcher || ethers.ZeroAddress} onClick={() => copyAddr(telemetry.dispatcher || ethers.ZeroAddress)}>
                  <CopyIcon size={11} />
                </button>
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelZkVerifier")}</span>
              <span className="admin-kv-val" title={telemetry.zkVerifier || ethers.ZeroAddress}>
                <span>{shortAddr(telemetry.zkVerifier || ethers.ZeroAddress)}</span>
                <button type="button" className="admin-copy-btn" title={telemetry.zkVerifier || ethers.ZeroAddress} onClick={() => copyAddr(telemetry.zkVerifier || ethers.ZeroAddress)}>
                  <CopyIcon size={11} />
                </button>
              </span>
            </div>
            <div className="admin-kv-row">
              <span className="admin-kv-key">{t("adminLabelIpfs")}</span>
              <span className="admin-kv-val">
                {pinataJwt ? "Pinata JWT" : t("adminPinataUnset")} | {kuboRpc || kuboGateway}
              </span>
            </div>
          </div>
        </section>

        {/* CARD 2: Dispatcher & ZK Verifier Governance */}
        <section id="admin-governance-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <ShieldCheckIcon size={16} color="#818cf8" />
              </span>
              {t("adminGovPanelTitle")}
            </h2>
          </div>

          <div className="form-field">
            <label className="field-label" htmlFor="admin-dispatcher-input">
              <span>{t("adminDispatcherLabel")}</span>
              <button
                id="admin-fill-dispatcher-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseConnected")}
                onClick={() => setDispatcherInput(account || telemetry.registryOwner || "")}
              >
                {t("adminBtnUseConnected")}
              </button>
            </label>
            <input
              id="admin-dispatcher-input"
              type="text"
              className="field-input"
              value={dispatcherInput}
              onChange={(e) => setDispatcherInput(e.target.value)}
              placeholder="0x..."
            />
            <button
              id="admin-set-dispatcher-btn"
              type="button"
              className="btn-terminal btn-terminal-primary admin-full-btn"
              title={t("adminSetDispatcherBtn")}
              disabled={busyAction === "dispatcher"}
              onClick={handleSetDispatcher}
            >
              {busyAction === "dispatcher" ? "..." : t("adminSetDispatcherBtn")}
            </button>
          </div>

          <div className="form-field" style={{ marginTop: "14px", marginBottom: 0 }}>
            <label className="field-label" htmlFor="admin-zkverifier-input">
              <span>{t("adminZkVerifierLabel")}</span>
              <button
                id="admin-fill-zkverifier-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseDeployed")}
                onClick={() => setZkVerifierInput(contractAddresses.GenomicZkVerifier || "")}
              >
                {t("adminBtnUseDeployed")}
              </button>
            </label>
            <input
              id="admin-zkverifier-input"
              type="text"
              className="field-input"
              value={zkVerifierInput}
              onChange={(e) => setZkVerifierInput(e.target.value)}
              placeholder="0x..."
            />
            <button
              id="admin-set-zkverifier-btn"
              type="button"
              className="btn-terminal btn-terminal-primary admin-full-btn"
              title={t("adminSetZkVerifierBtn")}
              disabled={busyAction === "zkverifier"}
              onClick={handleSetZkVerifier}
            >
              {busyAction === "zkverifier" ? "..." : t("adminSetZkVerifierBtn")}
            </button>
          </div>

          <div className="form-field" style={{ marginTop: "12px", marginBottom: 0 }}>
            <button
              id="admin-toggle-commitreveal-btn"
              type="button"
              className={`btn-terminal ${telemetry.commitRevealRequired ? "btn-terminal-success" : "btn-terminal-ghost"} admin-full-btn`}
              title={t("adminCommitRevealTooltip")}
              disabled={busyAction === "commitreveal"}
              onClick={handleToggleCommitReveal}
            >
              <span>
                {busyAction === "commitreveal"
                  ? "..."
                  : telemetry.commitRevealRequired
                  ? t("adminCommitRevealOn")
                  : t("adminCommitRevealOff")}
              </span>
            </button>
          </div>
        </section>

        {/* CARD 3: $GENO Treasury Mint & Registry Token Rescue */}
        <section id="admin-treasury-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <GenoTokenIcon size={16} color="#fbbf24" />
              </span>
              {t("adminTreasuryTitle")}
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-mint-to-input">
                {t("adminMintToLabel")}
              </label>
              <input
                id="admin-mint-to-input"
                type="text"
                className="field-input"
                value={mintToInput}
                onChange={(e) => setMintToInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-mint-amount-input">
                {t("adminMintAmountLabel")}
              </label>
              <input
                id="admin-mint-amount-input"
                type="number"
                className="field-input"
                value={mintAmountInput}
                onChange={(e) => setMintAmountInput(e.target.value)}
              />
            </div>
          </div>
          <button
            id="admin-mint-btn"
            type="button"
            className="btn-terminal btn-terminal-primary admin-full-btn"
            title={t("adminMintBtn")}
            disabled={busyAction === "mint"}
            onClick={handleMintGeno}
          >
            {busyAction === "mint" ? "..." : t("adminMintBtn")}
          </button>

          <div className="admin-section-divider">
            <span>{t("adminTreasuryDivider")}</span>
          </div>

          <div className="form-field">
            <label className="field-label" htmlFor="admin-rescue-token-input">
              {t("adminRescueTokenLabel")}
            </label>
            <input
              id="admin-rescue-token-input"
              type="text"
              className="field-input"
              value={rescueTokenInput}
              onChange={(e) => setRescueTokenInput(e.target.value)}
              placeholder={t("adminRescueTokenPlaceholder")}
            />
          </div>
          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-rescue-to-input">
                {t("adminRescueToLabel")}
              </label>
              <input
                id="admin-rescue-to-input"
                type="text"
                className="field-input"
                value={rescueToInput}
                onChange={(e) => setRescueToInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-rescue-amount-input">
                {t("adminRescueAmtLabel")}
              </label>
              <input
                id="admin-rescue-amount-input"
                type="number"
                className="field-input"
                value={rescueAmountInput}
                onChange={(e) => setRescueAmountInput(e.target.value)}
              />
            </div>
          </div>
          <button
            id="admin-rescue-btn"
            type="button"
            className="btn-terminal btn-terminal-danger admin-full-btn"
            title={t("adminRescueBtn")}
            disabled={busyAction === "rescue"}
            onClick={handleRescueTokens}
          >
            {busyAction === "rescue" ? "..." : t("adminRescueBtn")}
          </button>

          <div className="admin-section-divider">
            <span>{t("adminFaucetDivider")}</span>
          </div>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>
            <label
              htmlFor="admin-faucet-enabled-toggle"
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-primary)", cursor: "pointer", minHeight: "24px" }}
            >
              <input
                id="admin-faucet-enabled-toggle"
                type="checkbox"
                checked={faucetEnabledInput}
                onChange={(e) => setFaucetEnabledInput(e.target.checked)}
                style={{ width: "16px", height: "16px" }}
              />
              <span>{t("adminFaucetEnabledLabel")}</span>
            </label>
            <label
              htmlFor="admin-faucet-voucher-toggle"
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-primary)", cursor: "pointer", minHeight: "24px" }}
            >
              <input
                id="admin-faucet-voucher-toggle"
                type="checkbox"
                checked={faucetVoucherRequiredInput}
                onChange={(e) => setFaucetVoucherRequiredInput(e.target.checked)}
                style={{ width: "16px", height: "16px" }}
              />
              <span>{t("adminFaucetVoucherLabel")}</span>
            </label>
          </div>
          <div className="form-field" style={{ marginBottom: "8px" }}>
            <label className="field-label" htmlFor="admin-faucet-signer-input">
              <span>{t("adminFaucetSignerLabel")}</span>
              <button
                id="admin-fill-faucet-signer-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseConnected")}
                onClick={() => setFaucetSignerInput(account || telemetry.tokenOwner || "")}
              >
                {t("adminBtnUseConnected")}
              </button>
            </label>
            <input
              id="admin-faucet-signer-input"
              type="text"
              className="field-input"
              value={faucetSignerInput}
              onChange={(e) => setFaucetSignerInput(e.target.value)}
              placeholder="0x..."
            />
          </div>
          <button
            id="admin-set-faucet-config-btn"
            type="button"
            className="btn-terminal btn-terminal-primary admin-full-btn"
            title={t("adminFaucetConfigBtn")}
            disabled={busyAction === "faucet-config"}
            onClick={handleSetFaucetConfig}
          >
            {busyAction === "faucet-config" ? "..." : t("adminFaucetConfigBtn")}
          </button>
        </section>

        {/* CARD 4: ZK Trait Bounty Governance */}
        <section id="admin-bounty-card" className="studio-panel">
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <CpuChipIcon size={16} color="#10b981" />
              </span>
              {t("adminBountyTitle")} ({bounties.length})
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-trait-input">
                {t("adminBountyTraitLabel")}
              </label>
              <input
                id="admin-bounty-trait-input"
                type="text"
                className="field-input"
                value={bountyTraitInput}
                onChange={(e) => setBountyTraitInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-duration-input">
                {t("adminBountyDurationLabel")}
              </label>
              <input
                id="admin-bounty-duration-input"
                type="number"
                className="field-input"
                value={bountyDurationInput}
                onChange={(e) => setBountyDurationInput(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field" style={{ marginBottom: "12px" }}>
            <label className="field-label" htmlFor="admin-bounty-desc-input">
              {t("adminBountyDescLabel")}
            </label>
            <input
              id="admin-bounty-desc-input"
              type="text"
              className="field-input"
              value={bountyDescInput}
              onChange={(e) => setBountyDescInput(e.target.value)}
            />
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-reward-input">
                {t("adminBountyRewardLabel")}
              </label>
              <input
                id="admin-bounty-reward-input"
                type="number"
                className="field-input"
                value={bountyRewardInput}
                onChange={(e) => setBountyRewardInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-bounty-maxclaims-input">
                {t("adminBountyMaxClaimsLabel")}
              </label>
              <input
                id="admin-bounty-maxclaims-input"
                type="number"
                className="field-input"
                value={bountyMaxClaimsInput}
                onChange={(e) => setBountyMaxClaimsInput(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field" style={{ marginTop: "10px", marginBottom: "10px" }}>
            <label className="field-label" htmlFor="admin-bounty-attestor-input">
              <span>{t("adminBountyAttestorLabel")}</span>
              <button
                id="admin-fill-bounty-attestor-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseConnected")}
                onClick={() => {
                  bountyAttestorTouchedRef.current = true;
                  setBountyAttestorInput(account || telemetry.registryOwner || "");
                }}
              >
                {t("adminBtnUseConnected")}
              </button>
            </label>
            <input
              id="admin-bounty-attestor-input"
              type="text"
              className="field-input"
              value={bountyAttestorInput}
              onChange={(e) => {
                bountyAttestorTouchedRef.current = true;
                setBountyAttestorInput(e.target.value);
              }}
              required={telemetry.requireLabAttestation}
              placeholder={t("adminBountyAttestorPlaceholder")}
            />
          </div>

          <div className="admin-trait-hash-bar">
            <span>
              <strong>{t("adminTraitHashLabel")}:</strong> {computedTraitId.slice(0, 14)}...{computedTraitId.slice(-8)}
            </span>
            <button
              type="button"
              className="admin-copy-btn"
              title={computedTraitId}
              onClick={() => copyAddr(computedTraitId)}
            >
              <CopyIcon size={11} />
            </button>
          </div>

          <button
            id="admin-create-bounty-btn"
            type="button"
            className="btn-terminal btn-terminal-primary admin-full-btn"
            style={{ marginTop: 0 }}
            title={t("adminBountyCreateBtn")}
            disabled={busyAction === "bounty-create"}
            onClick={handleCreateZkBounty}
          >
            {busyAction === "bounty-create" ? "..." : t("adminBountyCreateBtn")}
          </button>

          {/* Compact ZK Lab Attestation Policy & Bounded Cleanup Controls */}
          <div className="admin-section-divider">
            <span>{t("adminZkPolicyDivider")}</span>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
            <button
              id="admin-zk-require-attestation-toggle"
              type="button"
              role="switch"
              aria-checked={telemetry.requireLabAttestation}
              className={`btn-terminal ${telemetry.requireLabAttestation ? "btn-terminal-success" : "btn-terminal-ghost"}`}
              style={{ flex: "1 1 200px", justifyContent: "center", fontSize: "11.5px", minHeight: "32px" }}
              title={t("adminZkRequireAttestationLabel")}
              disabled={busyAction === "zk-req-attest"}
              onClick={handleToggleRequireLabAttestation}
            >
              <span>
                {busyAction === "zk-req-attest"
                  ? "..."
                  : telemetry.requireLabAttestation
                    ? t("adminZkRequireAttestationOn")
                    : t("adminZkRequireAttestationOff")}
              </span>
            </button>
            <button
              id="admin-zk-prune-bounties-btn"
              type="button"
              className="btn-terminal btn-terminal-ghost"
              style={{ flex: "0 1 auto", justifyContent: "center", fontSize: "11.5px", minHeight: "32px", padding: "0 12px" }}
              title={t("adminZkPruneBountiesBtn")}
              disabled={busyAction === "zk-prune"}
              onClick={handlePruneExpiredBounties}
            >
              <span>{busyAction === "zk-prune" ? "..." : t("adminZkPruneBountiesBtn")}</span>
            </button>
          </div>

          <div className="form-field" style={{ marginBottom: "10px" }}>
            <label className="field-label" htmlFor="admin-zk-lab-attestor-input">
              <span>{t("adminZkLabAttestorLabel")}</span>
              <button
                id="admin-fill-zk-lab-btn"
                type="button"
                className="admin-inline-fill-btn"
                title={t("adminBtnUseConnected")}
                onClick={() => {
                  labAttestorTouchedRef.current = true;
                  setLabAttestorInput(account || telemetry.registryOwner || "");
                }}
              >
                {t("adminBtnUseConnected")}
              </button>
            </label>
            <input
              id="admin-zk-lab-attestor-input"
              type="text"
              className="field-input"
              value={labAttestorInput}
              onChange={(e) => {
                labAttestorTouchedRef.current = true;
                setLabAttestorInput(e.target.value);
              }}
              placeholder="0x..."
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button
                id="admin-zk-approve-lab-btn"
                type="button"
                className="btn-terminal btn-terminal-success"
                style={{ flex: 1, justifyContent: "center", fontSize: "11.5px", minHeight: "32px" }}
                title={t("adminZkApproveLabBtn")}
                disabled={busyAction.startsWith("zk-lab-")}
                onClick={() => handleSetApprovedLabAttestor(true)}
              >
                <span>{busyAction === "zk-lab-approve" ? "..." : t("adminZkApproveLabBtn")}</span>
              </button>
              <button
                id="admin-zk-revoke-lab-btn"
                type="button"
                className="btn-terminal btn-terminal-danger"
                style={{ flex: 1, justifyContent: "center", fontSize: "11.5px", minHeight: "32px", background: "#991b1b", color: "#ffffff", borderColor: "#991b1b" }}
                title={t("adminZkRevokeLabBtn")}
                disabled={busyAction.startsWith("zk-lab-")}
                onClick={() => handleSetApprovedLabAttestor(false)}
              >
                <span>{busyAction === "zk-lab-revoke" ? "..." : t("adminZkRevokeLabBtn")}</span>
              </button>
            </div>
          </div>

          {/* Active Bounties List */}
          <div className="admin-bounty-list">
            {bounties.map((b) => {
              const badgeCls = !b.isActive ? "is-closed" : b.isExpired ? "is-expired" : "is-active";
              const badgeText = !b.isActive
                ? t("adminBountyClosedBadge")
                : b.isExpired
                  ? t("adminBountyExpiredBadge")
                  : t("adminBountyActiveBadge");
              return (
                <div key={b.bountyId} className="admin-bounty-row">
                  <div style={{ fontSize: "12px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontWeight: 700, color: "var(--text-primary)" }}>
                      <span>#{b.bountyId} {b.traitDescription}</span>
                      <span className={`admin-bounty-badge ${badgeCls}`}>{badgeText}</span>
                      {b.requiredAttestor && (
                        <span className="status-badge-chip badge-active" style={{ fontSize: "10.5px", padding: "1px 7px" }}>
                          {t("adminBountyAttestedBadge")} ({shortAddr(b.requiredAttestor)})
                        </span>
                      )}
                    </div>
                    <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11px", marginTop: "3px" }}>
                      {b.rewardPerClaim} $GENO | {b.currentClaims}/{b.maxClaims} {t("adminClaimsUnit")} | {b.remainingFunding} $GENO
                    </div>
                  </div>
                  {b.isActive && (
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
                      <button
                        id={`admin-close-bounty-${b.bountyId}`}
                        type="button"
                        className="btn-terminal btn-terminal-ghost"
                        style={{ padding: "5px 10px", fontSize: "11.5px", minHeight: "28px" }}
                        title={t("adminBountyCloseBtn")}
                        disabled={busyAction === `close-${b.bountyId}`}
                        onClick={() => handleCloseBounty(b.bountyId)}
                      >
                        {t("adminBountyCloseBtn")}
                      </button>
                      <button
                        id={`admin-emergency-cancel-bounty-${b.bountyId}`}
                        type="button"
                        className="btn-terminal btn-terminal-danger"
                        style={{ padding: "5px 10px", fontSize: "11.5px", minHeight: "28px", background: "#991b1b", color: "#ffffff", borderColor: "#991b1b" }}
                        title={t("adminBountyEmergencyCancelBtn")}
                        disabled={busyAction === `cancel-${b.bountyId}`}
                        onClick={() => handleEmergencyCancelBounty(b.bountyId)}
                      >
                        {busyAction === `cancel-${b.bountyId}` ? "..." : t("adminBountyEmergencyCancelBtn")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* CARD 5: Escrow Dispute Arbiter Governance */}
        <section id="admin-escrow-disputes-card" className="studio-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-title-bar">
            <h2 className="panel-title">
              <span className="panel-title-icon-wrap">
                <AlertTriangleIcon size={16} color="var(--accent-rose-text)" />
              </span>
              {t("adminEscrowPanelTitle")}
            </h2>
          </div>

          <div className="form-group-row">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-dispute-dataid-input">
                {t("adminDisputeDataIdLabel")}
              </label>
              <input
                id="admin-dispute-dataid-input"
                type="number"
                className="field-input"
                value={disputeDataIdInput}
                onChange={(e) => setDisputeDataIdInput(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="admin-dispute-buyer-input">
                {t("adminDisputeBuyerLabel")}
              </label>
              <input
                id="admin-dispute-buyer-input"
                type="text"
                className="field-input"
                value={disputeBuyerInput}
                onChange={(e) => setDisputeBuyerInput(e.target.value)}
                placeholder="0x..."
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
            <button
              id="admin-resolve-refund-btn"
              type="button"
              className="btn-terminal btn-terminal-danger"
              style={{ flex: 1, justifyContent: "center", background: "#b91c1c", color: "#ffffff" }}
              disabled={busyAction.startsWith("dispute-")}
              onClick={() => handleResolveDispute(disputeDataIdInput, disputeBuyerInput, true)}
            >
              <span>{busyAction === "dispute-refund" ? "..." : t("adminResolveRefundBtn")}</span>
            </button>
            <button
              id="admin-resolve-release-btn"
              type="button"
              className="btn-terminal btn-terminal-success"
              style={{ flex: 1, justifyContent: "center" }}
              disabled={busyAction.startsWith("dispute-")}
              onClick={() => handleResolveDispute(disputeDataIdInput, disputeBuyerInput, false)}
            >
              <span>{busyAction === "dispute-release" ? "..." : t("adminResolveReleaseBtn")}</span>
            </button>
          </div>

          <div style={{ marginTop: "12px" }}>
            <div className="spec-box-label" style={{ marginBottom: "6px" }}>{t("adminActiveDisputesLabel")}</div>
            {disputes.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                {t("adminNoActiveDisputes")}
              </div>
            ) : (
              <div className="admin-bounty-list">
                {disputes.map((d) => (
                  <div key={`${d.dataId}-${d.buyer}`} className="admin-bounty-row">
                    <div style={{ fontSize: "12px", minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>
                        #{d.dataId} • {d.amount} $GENO
                      </div>
                      <div style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                        {lang === "vi" ? "Người mua" : "Buyer"}: {shortAddr(d.buyer)} | {lang === "vi" ? "Người bán" : "Seller"}: {shortAddr(d.seller)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-danger"
                        style={{ padding: "5px 10px", fontSize: "11px", background: "#b91c1c", color: "#ffffff" }}
                        disabled={Boolean(busyAction)}
                        onClick={() => handleResolveDispute(d.dataId, d.buyer, true)}
                      >
                        {t("adminResolveRefundBtn")}
                      </button>
                      <button
                        type="button"
                        className="btn-terminal btn-terminal-success"
                        style={{ padding: "5px 10px", fontSize: "11px" }}
                        disabled={Boolean(busyAction)}
                        onClick={() => handleResolveDispute(d.dataId, d.buyer, false)}
                      >
                        {t("adminResolveReleaseBtn")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}