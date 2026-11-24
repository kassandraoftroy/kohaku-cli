import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeAbiParameters,
  encodeAbiParameters,
  pad,
  toEventSelector,
  type Hex,
} from "viem";

import {
  privacyPoolsLogsFromSagaEvents,
  privacyPoolsSagaExclusiveEnd,
  privacyPoolsSagaLogPlan,
  privacyPoolsSagaSourceUrl,
} from "../src/utils/privacy-pools-saga.js";

const DEPOSIT_TOPIC = toEventSelector(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitment)"
);
const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const POOL = "0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb";

function deposit(block: bigint, commitment: bigint) {
  return {
    contractAddress: POOL as Hex,
    eventTopic: DEPOSIT_TOPIC,
    topics: [DEPOSIT_TOPIC, pad(DEPOSITOR)] as [Hex, Hex],
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [commitment, 1n, 10n, commitment + 1n]
    ),
    blockNumber: `0x${block.toString(16)}` as Hex,
    logIndex: "0x0" as Hex,
  };
}

describe("privacyPoolsSagaSourceUrl", () => {
  it("publishes mainnet and leaves Sepolia on eth_getLogs", () => {
    assert.equal(
      privacyPoolsSagaSourceUrl(1n),
      "https://saga-pp-state.global.ssl.fastly.net"
    );
    assert.equal(privacyPoolsSagaSourceUrl(11155111n), undefined);
  });
});

describe("privacyPoolsSagaExclusiveEnd", () => {
  it("uses the hot head when nothing is sealed", () => {
    assert.equal(
      privacyPoolsSagaExclusiveEnd({
        chunks: [],
        hotHead: { toBlock: "0x18f9bcf" },
      }),
      0x18f9bcfn
    );
  });

  it("takes the further of the sealed end and the hot head", () => {
    assert.equal(
      privacyPoolsSagaExclusiveEnd({
        chunks: [{ toBlock: "0x10" }],
        hotHead: { toBlock: "0x20" },
      }),
      0x20n
    );
  });
});

describe("privacyPoolsSagaLogPlan", () => {
  const sagaLast = 1_000n;

  it("uses eth_getLogs once the cursor is past saga", () => {
    assert.deepEqual(
      privacyPoolsSagaLogPlan({ fromBlock: 1_000n, sagaLast }),
      { kind: "rpc" }
    );
    assert.deepEqual(
      privacyPoolsSagaLogPlan({ fromBlock: 1_001n, toBlock: 1_100n, sagaLast }),
      { kind: "rpc" }
    );
  });

  it("reads saga history and starts the RPC tail at saga's exclusive end", () => {
    assert.deepEqual(
      privacyPoolsSagaLogPlan({ fromBlock: 100n, sagaLast }),
      { kind: "saga", sagaTo: sagaLast, tailFrom: sagaLast }
    );
  });

  it("skips the RPC tail when the request ends inside saga coverage", () => {
    assert.deepEqual(
      privacyPoolsSagaLogPlan({ fromBlock: 100n, toBlock: 400n, sagaLast }),
      { kind: "saga", sagaTo: 401n }
    );
  });
});

describe("privacyPoolsLogsFromSagaEvents", () => {
  it("ignores other contracts before returning logs or counting pool leaves", () => {
    const otherPool = "0x2222222222222222222222222222222222222222";
    const logs = privacyPoolsLogsFromSagaEvents({
      events: [
        { ...deposit(5n, 999n), contractAddress: otherPool as Hex },
        deposit(10n, 111n),
        { ...deposit(20n, 888n), contractAddress: otherPool as Hex },
        deposit(30n, 222n),
      ],
      pool: POOL.toUpperCase().replace("0X", "0x"),
      fromBlock: 20n,
      sagaTo: 31n,
    });
    assert.equal(logs.length, 2);
    assert.equal(logs[0]!.address, POOL);
    const [leafIndex, leaf] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      logs[1]!.data as Hex,
    );
    assert.equal(leafIndex, 2n);
    assert.equal(leaf, 222n);
  });

  it("rejects Saga 0.3 entity records instead of silently losing pool history", () => {
    assert.throws(() => privacyPoolsLogsFromSagaEvents({
      events: [deposit(10n, 111n), { entity: "derived-operation", blockNumber: "0x14", transactionIndex: "0x0", opIndex: "0x0" }],
      pool: POOL,
      fromBlock: 0n,
      sagaTo: 31n,
    }), /must contain raw log events/);
  });
  it("keeps absolute leaf indexes when the window starts mid-history", () => {
    const logs = privacyPoolsLogsFromSagaEvents({
      events: [deposit(10n, 111n), deposit(20n, 222n), deposit(30n, 333n)],
      pool: POOL,
      fromBlock: 20n,
      sagaTo: 31n,
    });
    const leaves = logs.filter((log) => log.topics[0] !== logs[0]?.topics[0]);
    assert.equal(logs.length, 4);
    assert.equal(leaves.length, 2);
    assert.match(leaves[0]!.data, /0x0*2/);
    assert.match(leaves[1]!.data, /0x0*3/);
  });
});
