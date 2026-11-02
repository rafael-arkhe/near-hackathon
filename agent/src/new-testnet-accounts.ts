// Operator tool: creates three NEAR implicit-account key pairs (vault, agent, anchor) on
// YOUR machine and prints the addresses to fund from a testnet faucet. An implicit account
// exists once it receives NEAR; its address is the hex of its public key.
//
// Usage: node src/new-testnet-accounts.ts <directory outside this repository>
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { KeyPair, keyToImplicitAddress } from "near-api-js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node src/new-testnet-accounts.ts <directory outside this repository>");
const target = resolve(dir);
const repo = resolve(import.meta.dirname, "..", "..");
const rel = relative(repo, target);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("refusing to write private keys inside the repository");

mkdirSync(target, { recursive: true, mode: 0o700 });
const rows: [string, string][] = [];
for (const role of ["vault", "agent", "anchor"]) {
  const key = KeyPair.fromRandom("ed25519");
  const address = keyToImplicitAddress(key.getPublicKey().toString());
  // flag "wx" never overwrites an existing key file.
  writeFileSync(resolve(target, `${role}.key`), key.toString() + "\n", { mode: 0o600, flag: "wx" });
  writeFileSync(resolve(target, `${role}.address`), address + "\n", { flag: "wx" });
  rows.push([role, address]);
}
console.log(`Private keys written to ${target} (vault.key, agent.key, anchor.key). Back them up offline.\n`);
for (const [role, address] of rows) console.log(`${role.padEnd(7)} ${address}`);
console.log("\nFund each address from a NEAR testnet faucet; it becomes an account when it receives NEAR.");
