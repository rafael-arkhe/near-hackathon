// Owner-side tool, run on the owner's machine. Reads the owner's mandate-signing key
// from a file the owner controls (never from this repository) and writes mandate.json.
//
// Usage: node src/sign-mandate.ts <owner-key.pem> <vault> <agent> <receiver[,receiver]> <maxTotalNEAR> <maxPerCallNEAR> <hours> <policyId> <out.json>
// Create the key once: node src/sign-mandate.ts --new-key <owner-key.pem>  (prints the public key hex for `new`)
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MANDATE_PROFILE, mandateId, signMandate, type Mandate } from "./mandate.ts";

const rawPublicHex = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const yocto = (near: string) => {
  const [w, f = ""] = near.split(".");
  return (BigInt(w) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString();
};

const args = process.argv.slice(2);
if (args[0] === "--new-key") {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(args[1], privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  console.log(`Wrote ${args[1]}. Keep it offline. Public key hex for agent-vault new(): ${rawPublicHex(readFileSync(args[1], "utf8"))}`);
} else {
  const [keyPath, vault, agent, receivers, maxTotal, maxPerCall, hours, policyId, out] = args;
  if (!out) throw new Error("see usage at the top of this file");
  const key = createPrivateKey(readFileSync(keyPath, "utf8"));
  const now = BigInt(Date.now()) * 1_000_000n;
  const mandate: Mandate = {
    profile: MANDATE_PROFILE, vault, agent, allowed_receivers: receivers.split(","),
    max_total: yocto(maxTotal), max_per_call: yocto(maxPerCall),
    not_before_ns: now.toString(), expires_at_ns: (now + BigInt(Math.round(Number(hours) * 3600)) * 10n ** 9n).toString(),
    nonce: BigInt("0x" + randomBytes(7).toString("hex")).toString(), policy_id: policyId
  };
  writeFileSync(out, JSON.stringify({ mandate, signature_hex: signMandate(mandate, key), mandate_id: mandateId(mandate) }, null, 2) + "\n");
  console.log(`Wrote ${out} (mandate ${mandateId(mandate)}). It contains no secret; give it to the agent.`);
}
