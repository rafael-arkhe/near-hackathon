// PUBLIC demo keys derived from fixed seeds. Anyone can sign with them: never fund
// an account or vault that trusts these keys.
import { createPrivateKey, createPublicKey } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function demoKey(seedByte: number) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seedByte)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPublicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { privateKey, publicKey, rawPublicHex };
}

export const DEMO_OWNER = demoKey(1);
export const DEMO_LOG = demoKey(7);
