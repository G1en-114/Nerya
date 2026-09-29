// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal strategy provenance registry; not ERC-721 or ERC-8004.
contract NeryaStrategyRegistry {
    mapping(bytes32 => address) public ownerOf;
    mapping(bytes32 => bytes32) public metadataHash;

    event StrategyRegistered(bytes32 indexed strategyId, address indexed owner, bytes32 metadataHash);

    function register(bytes32 strategyId, bytes32 metadataHash_) external {
        require(strategyId != bytes32(0) && metadataHash_ != bytes32(0), "empty_hash");
        require(ownerOf[strategyId] == address(0), "already_registered");
        ownerOf[strategyId] = msg.sender;
        metadataHash[strategyId] = metadataHash_;
        emit StrategyRegistered(strategyId, msg.sender, metadataHash_);
    }
}
