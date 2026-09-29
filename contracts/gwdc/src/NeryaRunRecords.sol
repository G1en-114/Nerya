// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NeryaStrategyRegistry} from "./NeryaStrategyRegistry.sol";

/// @notice Append-only commitments to off-chain records, not proof of a trade.
contract NeryaRunRecords {
    NeryaStrategyRegistry public immutable registry;
    mapping(bytes32 => mapping(bytes32 => bytes32)) public evidenceHash;

    event RunRecorded(bytes32 indexed strategyId, bytes32 indexed runId, bytes32 evidenceHash, address indexed recorder);

    constructor(address registry_) {
        require(registry_.code.length > 0, "invalid_registry");
        registry = NeryaStrategyRegistry(registry_);
    }

    function record(bytes32 strategyId, bytes32 runId, bytes32 evidenceHash_) external {
        require(registry.ownerOf(strategyId) == msg.sender, "owner_only");
        require(runId != bytes32(0) && evidenceHash_ != bytes32(0), "empty_hash");
        require(evidenceHash[strategyId][runId] == bytes32(0), "already_recorded");
        evidenceHash[strategyId][runId] = evidenceHash_;
        emit RunRecorded(strategyId, runId, evidenceHash_, msg.sender);
    }
}
