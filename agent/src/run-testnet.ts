// Live run against a deployed agent-vault. Configuration comes from environment variables;
// keys are read from files the operator controls. Not exercised by the offline tests.
//
//   NEAR_RPC=https://test.rpc.fastnear.com VAULT_ID=... AGENT_ID=...
//   AGENT_FC_KEY_FILE=agent-fc.key   (contents: ed25519:..., a function-call key for VAULT_ID/execute)
//   LOG_KEY_FILE=log-key.pem LOG_ID=... MANDATE_FILE=mandate.json
//   node src/run-testnet.ts "<trigger text>" [--skip-local-check]
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { EvidenceLog } from "./evidence-log.ts";
import { NearVaultExecutor } from "./executors.ts";
import { act } from "./guard.ts";
import { gullibleInjectablePlanner } from "./planner.ts";

const env = (name: string) => process.env[name] ?? (() => { throw new Error(`missing ${name}`); })();
// Accepts a bare "ed25519:..." key or a NEAR CLI credentials JSON ({ "private_key": "ed25519:..." }).
const readKey = (path: string) => {
  const text = readFileSync(path, "utf8").trim();
  return (text.startsWith("{") ? JSON.parse(text).private_key : text) as KeyPairString;
};
const [trigger, flag] = process.argv.slice(2);
if (!trigger) throw new Error("usage: node src/run-testnet.ts \"<trigger text>\" [--skip-local-check]");

const rpc = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const { mandate, signature_hex } = JSON.parse(readFileSync(env("MANDATE_FILE"), "utf8"));
const agentKey = readKey(env("AGENT_FC_KEY_FILE"));
const executor = new NearVaultExecutor(rpc, env("AGENT_ID"), agentKey, env("VAULT_ID"));
const log = new EvidenceLog(process.env.EVIDENCE_FILE ?? "evidence.jsonl");

const intent = gullibleInjectablePlanner(trigger);
const outcome = await act(trigger, intent, {
  mandate, signatureHex: signature_hex, executor, log, now: () => new Date(), skipLocalCheck: flag === "--skip-local-check"
});
console.log(JSON.stringify({ intent: intent && { ...intent, amount: intent.amount.toString() }, outcome }, null, 2));

if (process.env.LOG_KEY_FILE && process.env.LOG_ID && process.env.ANCHOR_ACCOUNT_ID && process.env.ANCHOR_KEY_FILE) {
  // Anchoring uses a separate account and key from the agent's function-call key.
  const { checkpoint, signatureHex } = log.checkpoint(env("LOG_ID"), createPrivateKey(readFileSync(env("LOG_KEY_FILE"), "utf8")),
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const anchor = new Account(env("ANCHOR_ACCOUNT_ID"), new JsonRpcProvider({ url: rpc }), readKey(env("ANCHOR_KEY_FILE")));
  await anchor.callFunction({ contractId: env("VAULT_ID"), methodName: "anchor_checkpoint", args: { checkpoint, signature_hex: signatureHex } });
  console.log(`Anchored checkpoint: ${checkpoint.leaf_count} records, root ${checkpoint.root_hex}`);
}
