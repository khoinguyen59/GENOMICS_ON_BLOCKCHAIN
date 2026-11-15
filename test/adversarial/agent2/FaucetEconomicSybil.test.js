/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.a)
 * Faucet economic fuzzer + INV-06 / INV-15 dual-sided anti-Sybil.
 *
 * Anti-tautology rule (INV-17): every assertion reads REAL on-chain state through
 * tx.wait() receipts, block timestamps or public view getters. No pure-JS
 * arithmetic is ever used as the source of truth.
 */
import { expect } from "chai";
import hre from "hardhat";

const COOLDOWN = 3600n;
const FAUCET_AMOUNT = 1000n * 10n ** 18n;

async function mineEmptyAt(ethers, ts) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
  await ethers.provider.send("evm_mine", []);
}

async function latest(ethers) {
  const b = await ethers.provider.getBlock("latest");
  return BigInt(b.timestamp);
}

async function blockTimeOf(ethers, receipt) {
  const b = await ethers.provider.getBlock(receipt.blockNumber);
  return BigInt(b.timestamp);
}

// Manual revert capture: returns { reverted, message, receipt } from REAL chain state.
async function capture(ethers, send) {
  try {
    const tx = await send();
    const receipt = await tx.wait();
    return { reverted: receipt.status !== 1, message: String(receipt.status), receipt };
  } catch (e) {
    return { reverted: true, message: String(e && e.message ? e.message : e), receipt: null };
  }
}

describe("AGENT2 :: Faucet Economic Fuzzer & Dual-Sided Anti-Sybil (INV-06 / INV-15)", function () {
  this.timeout(180000);
  let ethers, token, owner, alice, bob, carol;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, alice, bob, carol] = await ethers.getSigners();
    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();
  });

  it("A2-F01 faucet() enforces the FULL 3600s caller cooldown (T-1s reverts, exact T succeeds)", async function () {
    await token.connect(alice).faucet(alice.address);
    const t0 = await latest(ethers);
    const oneGrant = await token.balanceOf(alice.address);

    // tx would land at t0+3599 -> one second short of the window, MUST revert
    await mineEmptyAt(ethers, t0 + 3598n);
    const early = await capture(ethers, () => token.connect(alice).faucet(alice.address));
    expect(early.reverted).to.equal(true);
    expect(early.message).to.contain("FaucetCooldownActive(1)");
    expect(await token.balanceOf(alice.address)).to.equal(oneGrant);

    // advance the clock to exactly t0+3599 so the next tx mines at t0+3600
    await mineEmptyAt(ethers, t0 + 3599n);
    const tx = await token.connect(alice).faucet(alice.address);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);
    const claimTs = await blockTimeOf(ethers, receipt);
    expect(claimTs).to.equal(t0 + COOLDOWN);
    expect(await token.balanceOf(alice.address) - oneGrant).to.equal(FAUCET_AMOUNT);
    expect(await token.lastFaucetTime(alice.address)).to.equal(claimTs);
  });

  it("A2-F02 anti-Sybil: a fresh caller cannot drip into a recipient that is still cooling down", async function () {
    await token.connect(alice).faucet(alice.address);
    const t0 = await latest(ethers);

    // bob never touched the faucet; tx lands at t0+1800 -> 1800s still on the clock
    await mineEmptyAt(ethers, t0 + 1799n);
    await expect(token.connect(bob).faucet(alice.address))
      .to.be.revertedWithCustomError(token, "FaucetCooldownActive")
      .withArgs(1800n);

    // REAL state: alice got exactly one grant, bob got none, supply grew by one grant
    expect(await token.lastFaucetTime(alice.address)).to.equal(t0);
    expect(await token.balanceOf(alice.address)).to.equal(FAUCET_AMOUNT);
    expect(await token.balanceOf(bob.address)).to.equal(0n);
    expect(await token.totalSupply()).to.equal((await token.INITIAL_SUPPLY()) + FAUCET_AMOUNT);
  });

  it("A2-F03 recipient-side limit fires on the SECOND call even when the caller is fully cooled down", async function () {
    await token.connect(alice).faucet(bob.address);
    const t0 = await latest(ethers);

    // head = t0; mine empty at t0+3599 so the claim tx mines at t0+3600 (both sides free)
    await mineEmptyAt(ethers, t0 + 3599n);
    const ok = await token.connect(alice).faucet(bob.address);
    expect((await ok.wait()).status).to.equal(1);
    expect(await token.balanceOf(bob.address)).to.equal(2n * FAUCET_AMOUNT);

    // back-to-back second claim in the next block -> recipient clock blocks it
    await expect(token.connect(alice).faucet(bob.address))
      .to.be.revertedWithCustomError(token, "FaucetCooldownActive")
      .withArgs(3599n);
  });

  it("A2-F04 deterministic economic fuzzer: 40 randomized claim attempts never over-mint or half-mint", async function () {
    const actors = [alice, bob, carol, owner];
    const recipients = [alice.address, bob.address, carol.address];
    let successes = 0n;
    let seed = 0x5eed1234n;

    for (let i = 0; i < 40; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      const actor = actors[Number(seed % 4n)];
      const target = recipients[Number((seed >> 8n) % 3n)];
      const delta = 1n + ((seed >> 16n) % 4000n);

      const head = await latest(ethers);
      await mineEmptyAt(ethers, head + delta);

      const preSupply = await token.totalSupply();
      let receipt = null;
      try {
        const tx = await token.connect(actor).faucet(target);
        receipt = await tx.wait();
      } catch (e) {
        receipt = null;
      }
      const postSupply = await token.totalSupply();

      if (receipt && receipt.status === 1) {
        successes += 1n;
        const claimTs = await blockTimeOf(ethers, receipt);
        // exactly one grant minted, both clocks stamped with the REAL block time
        expect(postSupply - preSupply).to.equal(FAUCET_AMOUNT);
        expect(await token.lastFaucetTime(actor.address)).to.equal(claimTs);
        expect(await token.lastFaucetTime(target)).to.equal(claimTs);
      } else {
        // rejected claims must leave supply byte-identical (no partial mint)
        expect(postSupply).to.equal(preSupply);
      }
    }

    // global conservation over the whole fuzz run
    expect(await token.totalSupply()).to.equal(
      (await token.INITIAL_SUPPLY()) + successes * FAUCET_AMOUNT
    );
    expect(successes).to.be.greaterThan(0n);
  });

  it("A2-F05 zero-address recipient reverts InvalidRecipient and mints nothing", async function () {
    const pre = await token.totalSupply();
    await expect(token.connect(alice).faucet(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(token, "InvalidRecipient");
    expect(await token.totalSupply()).to.equal(pre);
    expect(await token.lastFaucetTime(alice.address)).to.equal(0n);
  });

  it("A2-F06 mint() is owner-only; the public faucet path cannot mint arbitrary amounts", async function () {
    await expect(token.connect(alice).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    const tx = await token.connect(owner).mint(bob.address, 7n);
    expect((await tx.wait()).status).to.equal(1);
    expect(await token.balanceOf(bob.address)).to.equal(7n);
  });

  it("A2-F07 Sybil scaling: faucet throughput is LINEAR in fresh wallet count (no identity gate)", async function () {
    const signers = await ethers.getSigners();
    const crowd = signers.slice(1, 11); // 10 brand-new wallets, same seed phrase
    const preSupply = await token.totalSupply();

    for (const s of crowd) {
      const tx = await token.connect(s).faucet(s.address);
      expect((await tx.wait()).status).to.equal(1);
      expect(await token.balanceOf(s.address)).to.equal(FAUCET_AMOUNT);
    }

    // Real on-chain accounting: 10 synthetic identities drained 10 full grants
    // inside a single minute of chain time, with zero rejections.
    expect((await token.totalSupply()) - preSupply).to.equal(10n * FAUCET_AMOUNT);

    // The clock is the ONLY defense: a second pass by the same wallets fails.
    await expect(token.connect(crowd[0]).faucet(crowd[0].address))
      .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
  });
});
