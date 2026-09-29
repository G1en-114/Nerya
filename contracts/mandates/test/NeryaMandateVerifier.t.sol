// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/NeryaMandateVerifier.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
    function chainId(uint256) external;
}

contract NeryaMandateVerifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    NeryaMandateVerifier verifier;
    NeryaMandateVerifier.Policy p;
    NeryaMandateVerifier.Action a;
    // Public test-only fixtures, never funded beyond local test execution.
    uint256 constant USER_KEY = 0x1234;
    uint256 constant AGENT_KEY = 0x5678;

    function setUp() public {
        vm.warp(1000);
        verifier = new NeryaMandateVerifier(keccak256("workspace"));
        p = NeryaMandateVerifier.Policy(vm.addr(USER_KEY), vm.addr(AGENT_KEY),
            keccak256("scope"), keccak256("market"), 100, 150, 900, 2000, 1, false);
        a = NeryaMandateVerifier.Action(verifier.policyHash(p), keccak256("plan"), p.market, 90, false, 1, 1900);
    }
    function sig(uint256 key, bytes32 h) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }
    function submit() private {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        verifier.authorize(p, ps, a, asig);
    }
    function testAllowAndReplayRejected() public {
        submit();
        require(verifier.authorized(a.policyHash, verifier.actionHash(a)), "missing authorization");
        require(verifier.spent(a.policyHash) == 90, "wrong budget");
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("replay"));
        verifier.authorize(p, ps, a, asig);
    }
    function testBudgetAcrossActions() public {
        submit(); a.nonce = 2;
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("session_budget_exceeded"));
        verifier.authorize(p, ps, a, asig);
        require(verifier.spent(a.policyHash) == 90, "budget changed on denial");
    }
    function testCostBoundary() public {
        a.cost = 101;
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("action_cost_exceeded"));
        verifier.authorize(p, ps, a, asig);
    }
    function testForbiddenMarket() public {
        a.market = keccak256("another market");
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("market_not_allowed"));
        verifier.authorize(p, ps, a, asig);
    }
    function testLongOpeningDenied() public {
        a.opensLong = true;
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("long_opening_not_allowed"));
        verifier.authorize(p, ps, a, asig);
    }
    function testPolicyTampering() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        p.budget = 999999;
        vm.expectRevert(bytes("invalid_signature"));
        verifier.authorize(p, ps, a, asig);
    }
    function testActionTampering() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        a.planHash = keccak256("altered plan");
        vm.expectRevert(bytes("invalid_signature"));
        verifier.authorize(p, ps, a, asig);
    }
    function testWrongAgentSigner() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(USER_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("invalid_signature"));
        verifier.authorize(p, ps, a, asig);
    }
    function testRevocationOwnerOnlyAndStopsNewActions() public {
        vm.expectRevert(bytes("owner_only")); verifier.revoke(p);
        vm.prank(p.owner); verifier.revoke(p);
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("revoked"));
        verifier.authorize(p, ps, a, asig);
    }
    function testExpiryAtBoundary() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.warp(1900);
        vm.expectRevert(bytes("expired_or_not_yet_valid"));
        verifier.authorize(p, ps, a, asig);
    }
    function testDifferentChainCannotReplaySignatures() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.chainId(block.chainid + 1);
        vm.expectRevert(bytes("invalid_signature"));
        verifier.authorize(p, ps, a, asig);
    }
    function testDifferentContractCannotReplaySignatures() public {
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        NeryaMandateVerifier other = new NeryaMandateVerifier(keccak256("workspace"));
        vm.expectRevert(bytes("invalid_signature"));
        other.authorize(p, ps, a, asig);
    }
    function testPolicyNonceCannotChangeTerms() public {
        submit(); p.budget = 999; a.policyHash = verifier.policyHash(p); a.nonce = 2;
        bytes memory ps = sig(USER_KEY, verifier.policyHash(p));
        bytes memory asig = sig(AGENT_KEY, verifier.actionHash(a));
        vm.expectRevert(bytes("policy_nonce_reused"));
        verifier.authorize(p, ps, a, asig);
    }
    function testFuzzSignedCost(uint96 cost) public {
        if (cost == 0 || cost > 100) return;
        a.cost = cost; submit();
        require(verifier.spent(a.policyHash) == cost, "wrong cost");
    }
}
