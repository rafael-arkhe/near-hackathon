// Mandate encoding shared with contracts/agent-vault: domain tag + Borsh(Mandate).
// fixtures/mandate-vector.json is checked by both the Rust and the TypeScript tests.
import { createHash, sign, type KeyObject } from "node:crypto";

export const MANDATE_PROFILE = "arkhe-guard-mandate@1";
const DOMAIN = Buffer.from("AKG:NEAR:MANDATE:v1\0", "utf8");

/** u128/u64 fields are decimal strings, as in the contract's JSON interface. */
export type Mandate = {
  profile: string;
  vault: string;
  agent: string;
  allowed_receivers: string[];
  max_total: string;
  max_per_call: string;
  not_before_ns: string;
  expires_at_ns: string;
  nonce: string;
  policy_id: string;
};

function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function str(s: string) { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); }
function uint(value: string, bytes: 8 | 16) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("expected a decimal integer string");
  let v = BigInt(value);
  if (v >= 1n << BigInt(bytes * 8)) throw new RangeError("integer out of range");
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

export function mandatePayload(m: Mandate): Buffer {
  return Buffer.concat([
    DOMAIN, str(m.profile), str(m.vault), str(m.agent),
    u32(m.allowed_receivers.length), ...m.allowed_receivers.map(str),
    uint(m.max_total, 16), uint(m.max_per_call, 16),
    uint(m.not_before_ns, 8), uint(m.expires_at_ns, 8), uint(m.nonce, 8),
    str(m.policy_id)
  ]);
}

export function mandateId(m: Mandate): string {
  return createHash("sha256").update(mandatePayload(m)).digest("hex");
}

/** Owner-side signing. The agent process never holds this key. */
export function signMandate(m: Mandate, ownerKey: KeyObject): string {
  return sign(null, mandatePayload(m), ownerKey).toString("hex");
}

/** Local pre-check mirroring the contract; the contract remains the authority. */
export function precheck(m: Mandate, spent: bigint, receiver: string, amount: bigint, nowNs: bigint): string | null {
  if (!(nowNs >= BigInt(m.not_before_ns) && nowNs < BigInt(m.expires_at_ns))) return "mandate not active";
  if (!m.allowed_receivers.includes(receiver)) return "receiver not allowed by mandate";
  if (amount <= 0n || amount > BigInt(m.max_per_call)) return "amount exceeds per-call limit";
  if (spent + amount > BigInt(m.max_total)) return "mandate budget exhausted";
  return null;
}
