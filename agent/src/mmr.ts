// Port of arkhe-verify-core mmr::inclusion (profile arkhe-mmr v1). Roots and proofs
// produced here verify with the Arkhe verification MCP; tests pin the shared vectors.
import { blake3 } from "@noble/hashes/blake3.js";

export type ProofStep = { kind: "node" | "bag"; direction: "left" | "right"; hashHex: string };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));

function leafHash(x: Uint8Array) { return blake3(cat(Uint8Array.of(0x00), x)); }
function nodeHash(l: Uint8Array, r: Uint8Array) { return blake3(cat(Uint8Array.of(0x01), l, r)); }

function mmrSize(n: number): bigint {
  let ones = 0;
  for (let v = n; v > 0; v = Math.floor(v / 2)) ones += v % 2;
  return 2n * BigInt(n) - BigInt(ones);
}

function bagHash(l: Uint8Array, r: Uint8Array, n: number) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(mmrSize(n));
  return blake3(cat(Uint8Array.of(0x02), size, l, r));
}

function peakWidths(n: number): number[] {
  const out: number[] = [];
  let rem = n;
  for (let bit = 2 ** Math.floor(Math.log2(n)); bit >= 1; bit /= 2) {
    if (rem >= bit) { out.push(bit); rem -= bit; }
  }
  return out;
}

function perfectRootAndPath(hashes: Uint8Array[], idx: number): [Uint8Array, ProofStep[]] {
  let level = hashes;
  const steps: ProofStep[] = [];
  while (level.length > 1) {
    const sib = idx ^ 1;
    steps.push({ kind: "node", direction: sib < idx ? "left" : "right", hashHex: hex(level[sib]) });
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return [level[0], steps];
}

export function buildRootAndProof(leaves: Uint8Array[], target: number): { rootHex: string; proof: ProofStep[] } {
  if (leaves.length === 0) throw new Error("empty MMR");
  if (!Number.isInteger(target) || target < 0 || target >= leaves.length) throw new Error("target out of range");
  const hashes = leaves.map(leafHash);
  const peaks: { start: number; width: number; root: Uint8Array }[] = [];
  let start = 0;
  for (const width of peakWidths(leaves.length)) {
    peaks.push({ start, width, root: perfectRootAndPath(hashes.slice(start, start + width), 0)[0] });
    start += width;
  }
  let root = peaks[peaks.length - 1].root;
  for (const p of peaks.slice(0, -1).reverse()) root = bagHash(p.root, root, leaves.length);

  const peakIndex = peaks.findIndex(p => p.start <= target && target < p.start + p.width);
  const peak = peaks[peakIndex];
  const proof = perfectRootAndPath(hashes.slice(peak.start, peak.start + peak.width), target - peak.start)[1];
  if (peakIndex < peaks.length - 1) {
    let acc = peaks[peaks.length - 1].root;
    for (const p of peaks.slice(peakIndex + 1, -1).reverse()) acc = bagHash(p.root, acc, leaves.length);
    proof.push({ kind: "bag", direction: "right", hashHex: hex(acc) });
  }
  for (const p of peaks.slice(0, peakIndex).reverse()) proof.push({ kind: "bag", direction: "left", hashHex: hex(p.root) });
  return { rootHex: hex(root), proof };
}

/** Recomputes the root from a leaf and proof; shape checks stay with the Arkhe verifier. */
export function rootFromProof(leaf: Uint8Array, leafCount: number, proof: ProofStep[]): string {
  let cur = leafHash(leaf);
  for (const step of proof) {
    const h = Uint8Array.from(Buffer.from(step.hashHex, "hex"));
    cur = step.kind === "node"
      ? (step.direction === "left" ? nodeHash(h, cur) : nodeHash(cur, h))
      : (step.direction === "left" ? bagHash(h, cur, leafCount) : bagHash(cur, h, leafCount));
  }
  return hex(cur);
}
