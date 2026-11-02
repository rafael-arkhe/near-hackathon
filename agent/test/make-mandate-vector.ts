// Regenerates ../fixtures/mandate-vector.json (owner key: PUBLIC demo seed 0x01).
import { writeFileSync } from "node:fs";
import { DEMO_OWNER } from "../src/demo-keys.ts";
import { MANDATE_PROFILE, mandateId, mandatePayload, signMandate, type Mandate } from "../src/mandate.ts";

const mandate: Mandate = {
  profile: MANDATE_PROFILE, vault: "vault.testnet", agent: "agent.testnet",
  allowed_receivers: ["supplier.testnet", "payroll.testnet"],
  max_total: "5000000000000000000000000", max_per_call: "2000000000000000000000000",
  not_before_ns: "1800000000000000000", expires_at_ns: "1800003600000000000",
  nonce: "7", policy_id: "demo-policy@1"
};
writeFileSync(new URL("../../fixtures/mandate-vector.json", import.meta.url), JSON.stringify({
  note: "Owner key is a PUBLIC demo key (seed 32 bytes of 0x01). Never trust it outside tests.",
  owner_public_key_hex: DEMO_OWNER.rawPublicHex,
  mandate,
  payload_hex: mandatePayload(mandate).toString("hex"),
  mandate_id_hex: mandateId(mandate),
  signature_hex: signMandate(mandate, DEMO_OWNER.privateKey)
}, null, 2) + "\n");
