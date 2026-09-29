// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-712 authorization registry prototype, NOT an AP2 implementation.
/// Does not execute CEX orders or attest to their real cost/position. The runtime
/// must bind planHash to its actual request and enforce its own Risk/ApprovalGate.
contract NeryaMandateVerifier {
    struct Policy {
        address owner;
        address agent;
        bytes32 scope;
        bytes32 market;
        uint256 maxCost;
        uint256 budget;
        uint256 validAfter;
        uint256 validUntil;
        uint256 nonce;
        bool allowLong;
    }
    struct Action {
        bytes32 policyHash;
        bytes32 planHash;
        bytes32 market;
        uint256 cost;
        bool opensLong;
        uint256 nonce;
        uint256 validUntil;
    }

    bytes32 public immutable workspace;
    bytes32 constant POLICY_TYPE = keccak256("Policy(address owner,address agent,bytes32 scope,bytes32 market,uint256 maxCost,uint256 budget,uint256 validAfter,uint256 validUntil,uint256 nonce,bool allowLong)");
    bytes32 constant ACTION_TYPE = keccak256("Action(bytes32 policyHash,bytes32 planHash,bytes32 market,uint256 cost,bool opensLong,uint256 nonce,uint256 validUntil)");
    mapping(bytes32 => bool) public revoked;
    mapping(bytes32 => uint256) public spent;
    mapping(bytes32 => mapping(uint256 => bool)) public usedNonce;
    mapping(bytes32 => mapping(bytes32 => bool)) public authorized;
    // An owner cannot accidentally reuse a mandate nonce with changed terms.
    mapping(address => mapping(uint256 => bytes32)) public policyByNonce;

    event ActionAuthorized(bytes32 indexed policyHash, bytes32 indexed actionHash,
        bytes32 indexed planHash, address owner, address agent, uint256 cost, uint256 nonce);
    event PolicyRevoked(bytes32 indexed policyHash, address indexed owner);

    constructor(bytes32 workspace_) { workspace = workspace_; }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"),
            keccak256("Nerya Mandates"), keccak256("1"), block.chainid, address(this), workspace
        ));
    }
    function policyHash(Policy calldata p) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(POLICY_TYPE, p))));
    }
    function actionHash(Action calldata a) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(ACTION_TYPE, a))));
    }
    function recover(bytes32 h, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "signature_length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) > 0 && uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 && (v == 27 || v == 28), "signature_format");
        address signer = ecrecover(h, v, r, s);
        require(signer != address(0), "signature_recovery");
        return signer;
    }
    function authorize(Policy calldata p, bytes calldata ps, Action calldata a, bytes calldata sig) external {
        bytes32 ph = policyHash(p);
        bytes32 ah = actionHash(a);
        require(p.owner != address(0) && p.agent != address(0), "zero_signer");
        require(recover(ph, ps) == p.owner && recover(ah, sig) == p.agent, "invalid_signature");
        require(a.policyHash == ph, "policy_hash_mismatch");
        require(!revoked[ph], "revoked");
        require(block.timestamp >= p.validAfter && block.timestamp < p.validUntil &&
            block.timestamp < a.validUntil && a.validUntil <= p.validUntil, "expired_or_not_yet_valid");
        require(p.maxCost > 0 && p.budget >= p.maxCost && a.cost > 0, "invalid_budget");
        require(a.market == p.market, "market_not_allowed");
        require(p.allowLong || !a.opensLong, "long_opening_not_allowed");
        require(a.cost <= p.maxCost, "action_cost_exceeded");
        require(!usedNonce[ph][a.nonce], "replay");
        bytes32 previous = policyByNonce[p.owner][p.nonce];
        require(previous == bytes32(0) || previous == ph, "policy_nonce_reused");
        require(a.cost <= p.budget - spent[ph], "session_budget_exceeded");
        policyByNonce[p.owner][p.nonce] = ph;
        usedNonce[ph][a.nonce] = true;
        spent[ph] += a.cost;
        authorized[ph][ah] = true;
        emit ActionAuthorized(ph, ah, a.planHash, p.owner, p.agent, a.cost, a.nonce);
    }
    function revoke(Policy calldata p) external {
        require(msg.sender == p.owner, "owner_only");
        bytes32 ph = policyHash(p);
        revoked[ph] = true;
        emit PolicyRevoked(ph, msg.sender);
    }
}
