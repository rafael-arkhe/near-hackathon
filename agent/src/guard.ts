// Worker step: turns a planner's payment intent into a vault call and records evidence.
// The planner is untrusted (it reads untrusted text); limits come only from the signed
// mandate, enforced again on chain by agent-vault.
import { createHash } from "node:crypto";
import { precheck, mandateId, type Mandate } from "./mandate.ts";
import type { EvidenceLog } from "./evidence-log.ts";

export type Intent = { receiver: string; amount: bigint };

export interface VaultExecutor {
  /** Calls agent-vault.execute; resolves with a tx hash or rejects with the contract's panic message. */
  execute(mandate: Mandate, signatureHex: string, receiver: string, amount: bigint): Promise<string>;
  spent(mandateIdHex: string): Promise<bigint>;
}

export type GuardOptions = {
  mandate: Mandate;
  signatureHex: string;
  executor: VaultExecutor;
  log: EvidenceLog;
  now: () => Date;
  /** Demo switch: skip the local pre-check to show the contract still refuses. */
  skipLocalCheck?: boolean;
};

export type Outcome = { status: "executed" | "refused_locally" | "refused_onchain"; reason: string | null; txHash: string | null };

export async function act(trigger: string, intent: Intent | null, o: GuardOptions): Promise<Outcome> {
  const base = {
    trigger_digest: createHash("sha256").update(trigger, "utf8").digest("hex"),
    mandate_id: mandateId(o.mandate),
    receiver: intent?.receiver ?? "",
    amount: (intent?.amount ?? 0n).toString()
  };
  const at = () => o.now().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!intent) {
    o.log.append({ ...base, at: at(), kind: "refused_locally", reason: "no payment intent", tx_hash: null });
    return { status: "refused_locally", reason: "no payment intent", txHash: null };
  }
  if (!o.skipLocalCheck) {
    const nowNs = BigInt(o.now().getTime()) * 1_000_000n;
    const reason = precheck(o.mandate, await o.executor.spent(base.mandate_id), intent.receiver, intent.amount, nowNs);
    if (reason) {
      o.log.append({ ...base, at: at(), kind: "refused_locally", reason, tx_hash: null });
      return { status: "refused_locally", reason, txHash: null };
    }
  }
  o.log.append({ ...base, at: at(), kind: "submitted", reason: null, tx_hash: null });
  try {
    const txHash = await o.executor.execute(o.mandate, o.signatureHex, intent.receiver, intent.amount);
    o.log.append({ ...base, at: at(), kind: "executed", reason: null, tx_hash: txHash });
    return { status: "executed", reason: null, txHash };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    o.log.append({ ...base, at: at(), kind: "refused_onchain", reason, tx_hash: null });
    return { status: "refused_onchain", reason, txHash: null };
  }
}
