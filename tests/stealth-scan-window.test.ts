import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultStealthImportStartBlock,
  stealthAnnouncerStartBlock,
} from "../src/lib/stealth/constants.js";
import {
  formatStealthScanStartLog,
  resolveStealthScanFloor,
  resolveStealthScanWindow,
} from "../src/lib/stealth/scan.js";

const MAINNET = 1n;
const SEPOLIA = 11155111n;
const LATEST = 30_000_000n;

describe("defaultStealthImportStartBlock", () => {
  it("uses the Kohaku-schema floors", () => {
    assert.equal(defaultStealthImportStartBlock(MAINNET), 25_700_000n);
    assert.equal(defaultStealthImportStartBlock(SEPOLIA), 11_455_454n);
  });
});

describe("resolveStealthScanFloor", () => {
  it("uses the Kohaku import default when start is omitted, not announcer deploy", () => {
    assert.equal(resolveStealthScanFloor({ chainId: MAINNET }), 25_700_000n);
    assert.equal(resolveStealthScanFloor({ chainId: SEPOLIA }), 11_455_454n);
    assert.ok(
      resolveStealthScanFloor({ chainId: MAINNET }) >
        stealthAnnouncerStartBlock(MAINNET)
    );
    assert.ok(
      resolveStealthScanFloor({ chainId: SEPOLIA }) >
        stealthAnnouncerStartBlock(SEPOLIA)
    );
  });

  it("honors an explicit block below the default but at/above deploy", () => {
    const deploy = stealthAnnouncerStartBlock(MAINNET);
    assert.equal(
      resolveStealthScanFloor({ chainId: MAINNET, startFromBlock: deploy }),
      deploy
    );
    assert.equal(
      resolveStealthScanFloor({
        chainId: MAINNET,
        startFromBlock: deploy + 1n,
      }),
      deploy + 1n
    );
  });

  it("clamps explicit 0 to the announcer deploy block", () => {
    assert.equal(
      resolveStealthScanFloor({ chainId: MAINNET, startFromBlock: 0n }),
      stealthAnnouncerStartBlock(MAINNET)
    );
    assert.equal(
      resolveStealthScanFloor({ chainId: SEPOLIA, startFromBlock: 0n }),
      stealthAnnouncerStartBlock(SEPOLIA)
    );
  });
});

describe("resolveStealthScanWindow", () => {
  it("starts a first pass at the Kohaku default", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
    });
    assert.equal(w.fromBlock, 25_700_000n);
    assert.equal(w.startFloor, 25_700_000n);
    assert.equal(w.needsFullHistory, true);
  });

  it("resumes a mid-pass forward past an earlier floor", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: 25_700_000n,
      lastScannedBlock: "25800000",
      fullHistoryScanned: false,
    });
    assert.equal(w.fromBlock, 25_800_001n);
  });

  it("resumes incrementally from lastScannedBlock+1 without backdate", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: 25_700_000n,
      lastScannedBlock: "28000000",
      fullHistoryScanned: true,
    });
    assert.equal(w.fromBlock, 28_000_001n);
    assert.equal(w.needsFullHistory, false);
  });

  it("does not treat the wallet-file floor as a back-date", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: 25_700_000n,
      lastScannedBlock: "28000000",
      fullHistoryScanned: true,
      backdate: false,
    });
    assert.equal(w.fromBlock, 28_000_001n);
  });

  it("back-dates from the CLI flag below lastScannedBlock", () => {
    const deploy = stealthAnnouncerStartBlock(MAINNET);
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: deploy,
      lastScannedBlock: "28000000",
      fullHistoryScanned: true,
      backdate: true,
    });
    assert.equal(w.fromBlock, deploy);
  });

  it("does not back-date when the flag is at or above the resume cursor", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: 29_000_000n,
      lastScannedBlock: "28000000",
      fullHistoryScanned: false,
      backdate: true,
    });
    assert.equal(w.fromBlock, 29_000_000n);
  });

  it("ignores a higher flag on incremental runs", () => {
    const w = resolveStealthScanWindow({
      chainId: MAINNET,
      latest: LATEST,
      startFromBlock: 29_000_000n,
      lastScannedBlock: "28000000",
      fullHistoryScanned: true,
      backdate: true,
    });
    assert.equal(w.fromBlock, 28_000_001n);
  });
});

describe("formatStealthScanStartLog", () => {
  it("prints start block and latest minus start", () => {
    assert.equal(
      formatStealthScanStartLog(25_700_000n, 25_800_000n),
      "Stealth scan from block 25700000 · 100000 blocks"
    );
  });
});
