/**
 * AGENT 6/6 — INDEPENDENT BLIND ADVERSARIAL TEST (Task 6)
 * Target: contracts/GenomicToken.sol faucet() — INVARIANT-15 (Anti-Sybil economic rate limiting)
 * All assertions read real EVM state after mined transactions (INV-17 anti-tautology).
 */
import fs from "node:fs";
import { expect } from "chai";
import hre from "hardhat";

const FAUCET = 1000n * 10n ** 18n;
const HOUR = 3600n;

describe("AGENT6 :: GenomicToken faucet economic fuzzer (INV-15)", function () {
  let ethers;
  let token;
  let owner, a1, a2, a3, a4, v1, v2;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, a1, a2, a3, a4, v1, v2] = await ethers.getSigners();
    const F = await ethers.getContractFactory("GenomicToken");
    token = await F.deploy(owner.address);
    await token.waitForDeployment();
  });

  const t = (addr) => token.lastFaucetTime(addr);

  it("F1 dual-sided rate limit: caller-side AND recipient-side must both block", async function () {
    // a1 funds v1
    await (await token.connect(a1).faucet(v1.address)).wait();

    // (i) recipient-side limit: v1 self-claiming must revert even though v1 never called
    await expect(token.connect(v1).faucet(v1.address)).to.be.revertedWithCustomError(
      token,
      "FaucetCooldownActive"
    );

    // (ii) caller-side limit: a1 funding a DIFFERENT fresh address must revert
    await expect(token.connect(a1).faucet(v2.address)).to.be.revertedWithCustomError(
      token,
      "FaucetCooldownActive"
    );

    // state read from EVM
    expect(await t(v1.address)).to.be.greaterThan(0n);
    expect(await t(a1.address)).to.equal(await t(v1.address));
    expect(await token.balanceOf(v1.address)).to.equal(FAUCET);
    expect(await token.balanceOf(v2.address)).to.equal(0n);
  });

  it("F2 cooldown boundary: still blocked at T+3599s, succeeds at exactly T+3600s", async function () {
    await (await token.connect(a1).faucet(a1.address)).wait();
    const ts0 = await t(a1.address);

    // Deterministic timestamps: setNextBlockTimestamp only (no separate evm_mine —
    // an automined block would consume the scheduled timestamp).
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts0 + 3599n)]);
    await expect(token.connect(a1).faucet(a1.address)).to.be.revertedWithCustomError(
      token,
      "FaucetCooldownActive"
    );

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts0 + HOUR)]);
    await (await token.connect(a1).faucet(a1.address)).wait();
    expect(await token.balanceOf(a1.address)).to.equal(FAUCET * 2n);
    expect(await t(a1.address)).to.equal(ts0 + HOUR);
  });

  it("F3 Sybil swarm: N distinct EOAs must each be capped at exactly one grant (no hidden inflation)", async function () {
    const swarm = [a1, a2, a3, a4, v1, v2];
    const supplyBefore = await token.totalSupply();

    for (const w of swarm) {
      await (await token.connect(w).faucet(w.address)).wait();
      expect(await token.balanceOf(w.address), `sybil ${w.address}`).to.equal(FAUCET);
    }

    // second round must revert for every member
    for (const w of swarm) {
      await expect(token.connect(w).faucet(w.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
    }

    const supplyAfter = await token.totalSupply();
    expect(supplyAfter - supplyBefore, "faucet inflation must equal exactly N * FAUCET_AMOUNT").to.equal(
      FAUCET * BigInt(swarm.length)
    );
  });

  it("F4 address(0) recipient and self-mapping isolation", async function () {
    await expect(token.connect(a1).faucet(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      token,
      "InvalidRecipient"
    );
    expect(await t(ethers.ZeroAddress)).to.equal(0n);
  });

  it("F5 advertised EOA-only faucet guard: dead-guard source sweep + real contract-caller behaviour", async function () {
    // contracts/GenomicToken.sol:27 declares `error ContractCallersNotAllowed();`,
    // advertising an EOA-only faucet (part of the INV-15 anti-Sybil story).
    const src = fs.readFileSync("contracts/GenomicToken.sol", "utf8");
    const declared = /^\s*error\s+ContractCallersNotAllowed\s*\(/m.test(src);
    const enforced = /revert\s+ContractCallersNotAllowed\s*[;(]/.test(src);
    expect(declared, "control: the error is declared in the source").to.equal(true);

    // BEHAVIOURAL PROBE: give a plain address real runtime bytecode (extcodesize > 0, i.e.
    // a genuine "contract caller") and let it drive faucet() through eth_sendTransaction.
    const contractCaller = "0x1111111111111111111111111111111111111111";
    const tokenCode = await ethers.provider.getCode(token.target);
    await ethers.provider.send("hardhat_setCode", [contractCaller, tokenCode]);
    await ethers.provider.send("hardhat_impersonateAccount", [contractCaller]);
    await ethers.provider.send("hardhat_setBalance", [contractCaller, "0x56bc75e2d63100000"]);
    expect(
      await ethers.provider.getCode(contractCaller),
      "control: the caller really is a contract (extcodesize > 0)"
    ).to.not.equal("0x");

    const data = token.interface.encodeFunctionData("faucet", [contractCaller]);
    let mined = false;
    let why = "";
    try {
      const txHash = await ethers.provider.send("eth_sendTransaction", [
        { from: contractCaller, to: await token.getAddress(), data },
      ]);
      const rc = await ethers.provider.waitForTransaction(txHash);
      mined = rc.status === 1;
      why = "receipt status=" + rc.status + " hash=" + rc.hash;
    } catch (e) {
      mined = false;
      why = String(e.shortMessage ?? e.message);
    }

    const mintedToContract = await token.balanceOf(contractCaller);
    const lastSeen = await token.lastFaucetTime(contractCaller);

    expect(
      mined,
      `a CONTRACT caller minted from the faucet (${why}, balance=${mintedToContract}, ` +
        "lastFaucetTime set => true). GenomicToken.sol:47-66 has no extcodesize/tx.origin check, " +
        "so a Sybil can deploy N cheap contracts and drain the faucet far faster than the " +
        "anti-Sybil framing in INVARIANT-15 promises (the 1h limit is per address, and every " +
        "deployed contract is a fresh address). Static sweep: declared=" +
        declared + ", enforced(revert ContractCallersNotAllowed)=" + enforced
    ).to.equal(false);
    expect(mintedToContract, "no faucet mint may reach a contract caller").to.equal(0n);
    expect(lastSeen, "no faucet bookkeeping for a contract caller").to.equal(0n);
  });

  it("F6 owner mint path stays onlyOwner (no privilege crossover with faucet)", async function () {
    await expect(token.connect(a1).mint(a1.address, 1n)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
    await (await token.connect(owner).mint(a2.address, 7n)).wait();
    expect(await token.balanceOf(a2.address)).to.equal(7n);
  });
});
