use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const T0: u64 = 1_800_000_000_000_000_000;

fn owner_key() -> SigningKey {
    SigningKey::from_bytes(&[1u8; 32])
}
fn log_key() -> SigningKey {
    // Same public test seed as the Arkhe verification MCP vector (32 bytes of 0x07).
    SigningKey::from_bytes(&[7u8; 32])
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("vault.testnet"))
        .predecessor_account_id(acc(predecessor))
        .account_balance(NearToken::from_yoctonear(100 * NEAR))
        .block_timestamp(now)
        .build());
}

fn vault() -> AgentVault {
    ctx("owner.testnet", T0);
    let mut v = AgentVault::new(hex::encode(owner_key().verifying_key().to_bytes()));
    v.set_log_key("test-log".into(), hex::encode(log_key().verifying_key().to_bytes()));
    v
}

fn mandate() -> Mandate {
    Mandate {
        profile: MANDATE_PROFILE.into(),
        vault: acc("vault.testnet"),
        agent: acc("agent.testnet"),
        allowed_receivers: vec![acc("supplier.testnet")],
        max_total: U128(5 * NEAR),
        max_per_call: U128(2 * NEAR),
        not_before_ns: U64(T0),
        expires_at_ns: U64(T0 + 3_600_000_000_000),
        nonce: U64(1),
        policy_id: "demo-policy@1".into(),
    }
}

fn sign(m: &Mandate, key: &SigningKey) -> String {
    hex::encode(key.sign(&mandate_payload(m)).to_bytes())
}

fn id(m: &Mandate) -> String {
    hex::encode(env::sha256_array(&mandate_payload(m)))
}

#[test]
fn mandate_payload_is_domain_tag_plus_borsh() {
    let p = mandate_payload(&mandate());
    assert!(p.starts_with(b"AKG:NEAR:MANDATE:v1\0"));
    // Borsh string: u32 little-endian length, then UTF-8 bytes.
    assert_eq!(&p[20..24], &(MANDATE_PROFILE.len() as u32).to_le_bytes());
    assert_eq!(&p[24..24 + MANDATE_PROFILE.len()], MANDATE_PROFILE.as_bytes());
}

#[test]
fn agent_spends_within_mandate_and_budget_accumulates() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m.clone(), sig.clone(), acc("supplier.testnet"), U128(2 * NEAR));
    let _ = v.execute(m.clone(), sig.clone(), acc("supplier.testnet"), U128(2 * NEAR));
    assert_eq!(v.get_spent(id(&m)).0, 4 * NEAR);
    assert_eq!(v.mandate_id(m), id(&mandate()));
}

#[test]
#[should_panic(expected = "mandate budget exhausted")]
fn budget_cannot_be_exceeded() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    for _ in 0..3 {
        let _ = v.execute(m.clone(), sig.clone(), acc("supplier.testnet"), U128(2 * NEAR));
    }
}

#[test]
#[should_panic(expected = "amount exceeds per-call limit")]
fn per_call_limit() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(3 * NEAR));
}

#[test]
#[should_panic(expected = "receiver not allowed by mandate")]
fn injected_receiver_is_refused() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("attacker.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "mandate signature invalid")]
fn widened_mandate_breaks_signature() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    let mut widened = m;
    widened.allowed_receivers.push(acc("attacker.testnet"));
    widened.max_total = U128(100 * NEAR);
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(widened, sig, acc("attacker.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "mandate signature invalid")]
fn mandate_signed_by_agent_is_refused() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &SigningKey::from_bytes(&[9u8; 32]));
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "caller is not the mandated agent")]
fn other_caller_cannot_use_mandate() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("someone.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "mandate not active")]
fn expired_mandate_is_refused() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", m.expires_at_ns.0);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "mandate is for another vault")]
fn mandate_for_other_vault_is_refused() {
    let mut v = vault();
    let mut m = mandate();
    m.vault = acc("other-vault.testnet");
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "mandate revoked")]
fn revoked_mandate_is_refused() {
    let mut v = vault();
    let m = mandate();
    let sig = sign(&m, &owner_key());
    v.revoke_mandate(id(&m));
    assert!(v.is_revoked(id(&m)));
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(NEAR));
}

#[test]
#[should_panic(expected = "only owner")]
fn agent_cannot_revoke_or_register_logs() {
    let mut v = vault();
    ctx("agent.testnet", T0 + 1);
    v.set_log_key("evil-log".into(), hex::encode([0u8; 32]));
}

#[test]
#[should_panic(expected = "vault balance too low")]
fn vault_keeps_storage_reserve() {
    let mut v = vault();
    let mut m = mandate();
    m.max_total = U128(1000 * NEAR);
    m.max_per_call = U128(1000 * NEAR);
    let sig = sign(&m, &owner_key());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, sig, acc("supplier.testnet"), U128(100 * NEAR));
}

fn vector() -> (Checkpoint, String) {
    let raw: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("../../../fixtures/checkpoint-vector.json")).unwrap();
    let request = &raw["request"];
    (
        near_sdk::serde_json::from_value(request["checkpoint"].clone()).unwrap(),
        request["signatureHex"].as_str().unwrap().to_string(),
    )
}

#[test]
fn anchors_the_checkpoint_signed_for_the_verification_mcp() {
    let mut v = vault();
    let (c, sig) = vector();
    ctx("anyone.testnet", T0 + 1);
    v.anchor_checkpoint(c.clone(), sig);
    assert_eq!(v.get_checkpoint("test-log".into()), Some(c));
}

fn signed_checkpoint(leaf_count: u32, issued_at: &str, root_byte: u8) -> (Checkpoint, String) {
    let c = Checkpoint {
        profile: CHECKPOINT_PROFILE.into(),
        log_id: "test-log".into(),
        mmr_profile_digest: MMR_PROFILE_DIGEST_HEX.into(),
        root_hex: hex::encode([root_byte; 32]),
        leaf_count,
        issued_at: issued_at.into(),
    };
    let sig = hex::encode(log_key().sign(&checkpoint_payload(&c)).to_bytes());
    (c, sig)
}

#[test]
fn checkpoints_only_move_forward() {
    let mut v = vault();
    let (c1, s1) = signed_checkpoint(5, "2026-11-01T00:00:00Z", 1);
    v.anchor_checkpoint(c1, s1);
    let (c2, s2) = signed_checkpoint(8, "2026-11-01T01:00:00Z", 2);
    v.anchor_checkpoint(c2.clone(), s2);
    assert_eq!(v.get_checkpoint("test-log".into()), Some(c2));
}

#[test]
#[should_panic(expected = "checkpoint does not extend the log")]
fn same_size_fork_is_refused() {
    let mut v = vault();
    let (c1, s1) = signed_checkpoint(5, "2026-11-01T00:00:00Z", 1);
    v.anchor_checkpoint(c1, s1);
    let (c2, s2) = signed_checkpoint(5, "2026-11-01T01:00:00Z", 2);
    v.anchor_checkpoint(c2, s2);
}

#[test]
#[should_panic(expected = "checkpoint signature invalid")]
fn tampered_checkpoint_is_refused() {
    let mut v = vault();
    let (mut c, sig) = vector();
    c.leaf_count += 1;
    v.anchor_checkpoint(c, sig);
}

#[test]
#[should_panic(expected = "unknown log")]
fn unregistered_log_is_refused() {
    let mut v = vault();
    let (mut c, sig) = vector();
    c.log_id = "other-log".into();
    v.anchor_checkpoint(c, sig);
}

#[test]
#[should_panic(expected = "invalid log id")]
fn log_id_needing_json_escape_is_refused() {
    let mut v = vault();
    let (mut c, sig) = vector();
    c.log_id = "test\"log".into();
    v.anchor_checkpoint(c, sig);
}

#[test]
fn typescript_agent_mandate_vector_matches_contract_encoding() {
    let raw: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("../../../fixtures/mandate-vector.json")).unwrap();
    let m: Mandate = near_sdk::serde_json::from_value(raw["mandate"].clone()).unwrap();
    let payload = mandate_payload(&m);
    assert_eq!(hex::encode(&payload), raw["payload_hex"].as_str().unwrap());
    assert_eq!(hex::encode(env::sha256_array(&payload)), raw["mandate_id_hex"].as_str().unwrap());
    // The TypeScript demo owner key is the same public seed as owner_key() here.
    assert_eq!(hex::encode(owner_key().verifying_key().to_bytes()), raw["owner_public_key_hex"].as_str().unwrap());

    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("vault.testnet"))
        .predecessor_account_id(acc("owner.testnet"))
        .account_balance(NearToken::from_yoctonear(100 * NEAR))
        .block_timestamp(T0)
        .build());
    let mut v = AgentVault::new(raw["owner_public_key_hex"].as_str().unwrap().to_string());
    ctx("agent.testnet", T0 + 1);
    let _ = v.execute(m, raw["signature_hex"].as_str().unwrap().to_string(), acc("payroll.testnet"), U128(NEAR));
    assert_eq!(v.get_spent(raw["mandate_id_hex"].as_str().unwrap().to_string()).0, NEAR);
}
