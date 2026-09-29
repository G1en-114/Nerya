// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NeryaStrategyRegistry} from "../src/NeryaStrategyRegistry.sol";
import {NeryaRunRecords} from "../src/NeryaRunRecords.sol";

contract OtherRecorder {
    function record(NeryaRunRecords records, bytes32 strategy, bytes32 run, bytes32 evidence) external {
        records.record(strategy, run, evidence);
    }
}

contract NeryaRecordsTest {
    NeryaStrategyRegistry registry;
    NeryaRunRecords records;
    bytes32 constant STRATEGY = keccak256("nerya-gwdc");
    bytes32 constant RUN = keccak256("run-1");
    bytes32 constant EVIDENCE = keccak256("evidence");

    function setUp() public {
        registry = new NeryaStrategyRegistry();
        records = new NeryaRunRecords(address(registry));
        registry.register(STRATEGY, EVIDENCE);
    }

    function testRegisterAndRecord() public {
        records.record(STRATEGY, RUN, EVIDENCE);
        require(registry.ownerOf(STRATEGY) == address(this));
        require(records.evidenceHash(STRATEGY, RUN) == EVIDENCE);
    }

    function testCannotOverwriteStrategy() public {
        (bool ok,) = address(registry).call(abi.encodeCall(registry.register, (STRATEGY, RUN)));
        require(!ok);
        require(registry.metadataHash(STRATEGY) == EVIDENCE);
    }

    function testCannotOverwriteRun() public {
        records.record(STRATEGY, RUN, EVIDENCE);
        (bool ok,) = address(records).call(abi.encodeCall(records.record, (STRATEGY, RUN, STRATEGY)));
        require(!ok);
        require(records.evidenceHash(STRATEGY, RUN) == EVIDENCE);
    }

    function testOnlyStrategyOwnerCanRecord() public {
        OtherRecorder other = new OtherRecorder();
        (bool ok,) = address(other).call(abi.encodeCall(other.record, (records, STRATEGY, RUN, EVIDENCE)));
        require(!ok);
        require(records.evidenceHash(STRATEGY, RUN) == bytes32(0));
    }

    function testUnknownStrategyAndEmptyHashRejected() public {
        (bool ok,) = address(records).call(abi.encodeCall(records.record, (RUN, RUN, EVIDENCE)));
        require(!ok);
        (ok,) = address(records).call(abi.encodeCall(records.record, (STRATEGY, RUN, bytes32(0))));
        require(!ok);
    }
}
