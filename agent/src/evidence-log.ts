// Append-only evidence log. Each record is a leaf of an Arkhe MMR; checkpoints use
// arkhe-mmr-checkpoint@1, the format agent-vault anchors and the verification MCP checks.
import { sign, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { jcs } from "./canonical.ts";
import { buildRootAndProof, type ProofStep } from "./mmr.ts";

export const CHECKPOINT_PROFILE = "arkhe-mmr-checkpoint@1";
export const MMR_PROFILE_DIGEST_HEX = "bcd07a275061ef385fccdd184030c2358fdd0937477cb0ef30cf8148342f2450";
const LEAF_DOMAIN = "AKG:GUARD:EVENT:v1\0";
const CHECKPOINT_DOMAIN = "AKG:MMR:CHECKPOINT:v1\0";

/** Records hold digests and decisions, never trigger text or secrets. */
export type EvidenceRecord = {
  seq: number;
  at: string;
  kind: "refused_locally" | "submitted" | "executed" | "refused_onchain";
  trigger_digest: string;
  mandate_id: string;
  receiver: string;
  amount: string;
  reason: string | null;
  tx_hash: string | null;
};

export type Checkpoint = {
  profile: string; log_id: string; mmr_profile_digest: string;
  root_hex: string; leaf_count: number; issued_at: string;
};

export function leafBytes(r: EvidenceRecord): Uint8Array {
  return Uint8Array.from(Buffer.from(LEAF_DOMAIN + jcs(r), "utf8"));
}

export function checkpointBytes(c: Checkpoint): Buffer {
  return Buffer.from(CHECKPOINT_DOMAIN + jcs(c), "utf8");
}

export class EvidenceLog {
  readonly path: string | null;
  readonly records: EvidenceRecord[] = [];

  constructor(path: string | null = null) {
    this.path = path;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) if (line) this.records.push(JSON.parse(line));
    }
  }

  append(entry: Omit<EvidenceRecord, "seq">): EvidenceRecord {
    const record = { seq: this.records.length, ...entry };
    this.records.push(record);
    if (this.path) appendFileSync(this.path, jcs(record) + "\n");
    return record;
  }

  checkpoint(logId: string, logKey: KeyObject, issuedAt: string): { checkpoint: Checkpoint; signatureHex: string } {
    if (this.records.length === 0) throw new Error("empty log");
    const { rootHex } = buildRootAndProof(this.records.map(leafBytes), 0);
    const checkpoint: Checkpoint = {
      profile: CHECKPOINT_PROFILE, log_id: logId, mmr_profile_digest: MMR_PROFILE_DIGEST_HEX,
      root_hex: rootHex, leaf_count: this.records.length, issued_at: issuedAt
    };
    return { checkpoint, signatureHex: sign(null, checkpointBytes(checkpoint), logKey).toString("hex") };
  }

  /** Inclusion request in the shape arkhe_verify_checkpoint expects. */
  inclusion(seq: number): { leafHex: string; proof: ProofStep[] } {
    const leaves = this.records.map(leafBytes);
    return { leafHex: Buffer.from(leaves[seq]).toString("hex"), proof: buildRootAndProof(leaves, seq).proof };
  }
}
