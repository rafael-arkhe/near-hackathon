//! Agent vault: an AI agent can move funds only within an owner-signed mandate.
//!
//! The agent calls `execute` from its own account, ideally through a function-call
//! access key restricted to this contract and method. Every limit is enforced here,
//! on chain; nothing the agent (or text it reads) says can widen a mandate.
//! The vault also anchors Ed25519-signed MMR checkpoints so third parties can
//! check an evidence log offline against an on-chain root.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub const MANDATE_PROFILE: &str = "arkhe-guard-mandate@1";
const MANDATE_DOMAIN: &[u8] = b"AKG:NEAR:MANDATE:v1\0";
pub const CHECKPOINT_PROFILE: &str = "arkhe-mmr-checkpoint@1";
const CHECKPOINT_DOMAIN: &str = "AKG:MMR:CHECKPOINT:v1\0";
/// arkhe-verify-core mmr::profile::PROFILE_DIGEST_HEX
pub const MMR_PROFILE_DIGEST_HEX: &str = "bcd07a275061ef385fccdd184030c2358fdd0937477cb0ef30cf8148342f2450";
const MAX_RECEIVERS: usize = 16;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub profile: String,
    pub vault: AccountId,
    pub agent: AccountId,
    pub allowed_receivers: Vec<AccountId>,
    pub max_total: U128,
    pub max_per_call: U128,
    pub not_before_ns: U64,
    pub expires_at_ns: U64,
    pub nonce: U64,
    pub policy_id: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Checkpoint {
    pub profile: String,
    pub log_id: String,
    pub mmr_profile_digest: String,
    pub root_hex: String,
    pub leaf_count: u32,
    pub issued_at: String,
}

#[near(serializers = [json])]
pub struct Execution {
    pub mandate_id: String,
    pub receiver: AccountId,
    pub amount: U128,
    pub spent_total: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentVault {
    owner: AccountId,
    owner_key: [u8; 32],
    spent: LookupMap<[u8; 32], u128>,
    revoked: LookupMap<[u8; 32], bool>,
    log_keys: LookupMap<String, [u8; 32]>,
    checkpoints: LookupMap<String, Checkpoint>,
}

/// Bytes the owner signs: a domain tag followed by the Borsh encoding of the mandate.
pub fn mandate_payload(m: &Mandate) -> Vec<u8> {
    let mut out = MANDATE_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(m).expect("borsh"));
    out
}

/// JCS of the checkpoint. Field charsets are validated first, so no JSON escaping is needed
/// and the bytes equal what the Arkhe verification MCP signs and verifies.
pub fn checkpoint_payload(c: &Checkpoint) -> Vec<u8> {
    format!(
        "{CHECKPOINT_DOMAIN}{{\"issued_at\":\"{}\",\"leaf_count\":{},\"log_id\":\"{}\",\"mmr_profile_digest\":\"{}\",\"profile\":\"{}\",\"root_hex\":\"{}\"}}",
        c.issued_at, c.leaf_count, c.log_id, c.mmr_profile_digest, c.profile, c.root_hex
    )
    .into_bytes()
}

fn key32(hex_key: &str) -> [u8; 32] {
    let bytes = hex::decode(hex_key).unwrap_or_else(|_| env::panic_str("key must be hex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("key must be 32 bytes"))
}

fn sig64(hex_sig: &str) -> [u8; 64] {
    let bytes = hex::decode(hex_sig).unwrap_or_else(|_| env::panic_str("signature must be hex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"))
}

fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
}

fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

#[near]
impl AgentVault {
    #[init]
    pub fn new(owner_key_hex: String) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            owner_key: key32(&owner_key_hex),
            spent: LookupMap::new(b"s"),
            revoked: LookupMap::new(b"r"),
            log_keys: LookupMap::new(b"l"),
            checkpoints: LookupMap::new(b"c"),
        }
    }

    /// Moves `amount` yoctoNEAR to `receiver` if, and only if, the owner-signed mandate allows it.
    /// Budget is consumed before the transfer is scheduled.
    pub fn execute(&mut self, mandate: Mandate, signature_hex: String, receiver: AccountId, amount: U128) -> Promise {
        let payload = mandate_payload(&mandate);
        let id = env::sha256_array(&payload);
        require!(mandate.profile == MANDATE_PROFILE, "unsupported mandate profile");
        require!(mandate.vault == env::current_account_id(), "mandate is for another vault");
        require!(mandate.agent == env::predecessor_account_id(), "caller is not the mandated agent");
        require!(
            env::ed25519_verify(&sig64(&signature_hex), &payload, &self.owner_key),
            "mandate signature invalid"
        );
        require!(!self.revoked.get(&id).copied().unwrap_or(false), "mandate revoked");
        let now = env::block_timestamp();
        require!(now >= mandate.not_before_ns.0 && now < mandate.expires_at_ns.0, "mandate not active");
        require!(
            !mandate.allowed_receivers.is_empty() && mandate.allowed_receivers.len() <= MAX_RECEIVERS,
            "mandate receiver list invalid"
        );
        require!(mandate.allowed_receivers.contains(&receiver), "receiver not allowed by mandate");
        let amount = amount.0;
        require!(amount > 0 && amount <= mandate.max_per_call.0, "amount exceeds per-call limit");
        let spent = self.spent.get(&id).copied().unwrap_or(0);
        let total = spent.checked_add(amount).unwrap_or_else(|| env::panic_str("overflow"));
        require!(total <= mandate.max_total.0, "mandate budget exhausted");
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() + 100);
        require!(env::account_balance().as_yoctonear() >= amount + storage, "vault balance too low");

        self.spent.insert(id, total);
        let event = Execution {
            mandate_id: hex::encode(id),
            receiver: receiver.clone(),
            amount: U128(amount),
            spent_total: U128(total),
        };
        log!(
            "EVENT_JSON:{{\"standard\":\"arkhe-guard\",\"version\":\"1.0.0\",\"event\":\"mandate_execution\",\"data\":[{}]}}",
            near_sdk::serde_json::to_string(&event).expect("json")
        );
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount))
    }

    /// Owner kill switch for a mandate, identified by the SHA-256 of its signed payload.
    pub fn revoke_mandate(&mut self, mandate_id_hex: String) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        self.revoked.insert(key32(&mandate_id_hex), true);
        log!("EVENT_JSON:{{\"standard\":\"arkhe-guard\",\"version\":\"1.0.0\",\"event\":\"mandate_revoked\",\"data\":[{{\"mandate_id\":\"{}\"}}]}}", mandate_id_hex);
    }

    pub fn set_log_key(&mut self, log_id: String, key_hex: String) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        require!(is_identifier(&log_id), "invalid log id");
        self.log_keys.insert(log_id, key32(&key_hex));
    }

    /// Anchors a checkpoint signed by the registered key of its log. Roots only move forward:
    /// a smaller or equal leaf count, a reused timestamp or a different root for the same
    /// count is rejected.
    pub fn anchor_checkpoint(&mut self, checkpoint: Checkpoint, signature_hex: String) {
        let c = &checkpoint;
        require!(c.profile == CHECKPOINT_PROFILE, "unsupported checkpoint profile");
        require!(c.mmr_profile_digest == MMR_PROFILE_DIGEST_HEX, "unsupported MMR profile");
        require!(is_identifier(&c.log_id), "invalid log id");
        require!(is_lower_hex64(&c.root_hex), "invalid root");
        require!(is_timestamp(&c.issued_at), "invalid timestamp");
        require!(c.leaf_count >= 1, "empty log");
        let key = *self.log_keys.get(&c.log_id).unwrap_or_else(|| env::panic_str("unknown log"));
        require!(env::ed25519_verify(&sig64(&signature_hex), &checkpoint_payload(c), &key), "checkpoint signature invalid");
        if let Some(last) = self.checkpoints.get(&c.log_id) {
            require!(c.leaf_count > last.leaf_count, "checkpoint does not extend the log");
            require!(c.issued_at > last.issued_at, "checkpoint time does not advance");
        }
        log!(
            "EVENT_JSON:{{\"standard\":\"arkhe-guard\",\"version\":\"1.0.0\",\"event\":\"checkpoint_anchored\",\"data\":[{{\"log_id\":\"{}\",\"root_hex\":\"{}\",\"leaf_count\":{}}}]}}",
            c.log_id, c.root_hex, c.leaf_count
        );
        self.checkpoints.insert(c.log_id.clone(), checkpoint);
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn mandate_id(&self, mandate: Mandate) -> String {
        hex::encode(env::sha256_array(&mandate_payload(&mandate)))
    }

    pub fn get_spent(&self, mandate_id_hex: String) -> U128 {
        U128(self.spent.get(&key32(&mandate_id_hex)).copied().unwrap_or(0))
    }

    pub fn is_revoked(&self, mandate_id_hex: String) -> bool {
        self.revoked.get(&key32(&mandate_id_hex)).copied().unwrap_or(false)
    }

    pub fn get_checkpoint(&self, log_id: String) -> Option<Checkpoint> {
        self.checkpoints.get(&log_id).cloned()
    }
}

#[cfg(test)]
mod tests;
