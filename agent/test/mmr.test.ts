import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRootAndProof, rootFromProof } from "../src/mmr.ts";

const vectors = [1, 3, 4, 5, 7].map(n => JSON.parse(readFileSync(new URL(`../../fixtures/mmr/${n}-leaves.json`, import.meta.url), "utf8")));

test("TypeScript MMR reproduces every Arkhe Rust vector root and proof", () => {
  let checked = 0;
  for (const v of vectors) {
    const leaves = v.input.leaves.map((h: string) => Uint8Array.from(Buffer.from(h, "hex")));
    for (const p of v.expected_output.proofs) {
      const { rootHex, proof } = buildRootAndProof(leaves, p.target_index);
      assert.equal(rootHex, v.expected_output.root_hash_hex);
      assert.deepEqual(proof.map(s => s.hashHex), p.inclusion_proof_hashes);
      assert.deepEqual(proof.map(s => s.kind), p.inclusion_proof_kinds);
      assert.deepEqual(proof.map(s => s.direction), p.inclusion_proof_directions);
      assert.equal(rootFromProof(leaves[p.target_index], leaves.length, proof), rootHex);
      checked++;
    }
  }
  assert.equal(checked, 20);
});

test("out-of-range targets and empty logs are refused", () => {
  assert.throws(() => buildRootAndProof([], 0));
  assert.throws(() => buildRootAndProof([Uint8Array.of(1)], 1));
  assert.throws(() => buildRootAndProof([Uint8Array.of(1)], -1));
});
