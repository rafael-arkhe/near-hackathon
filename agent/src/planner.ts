// A deliberately gullible planner: it obeys any "pay N NEAR to X" it reads, including
// text injected into an email or issue. It stands in for a compromised LLM so the demo
// shows that safety does not depend on the model resisting injection.
import type { Intent } from "./guard.ts";

const YOCTO_PER_NEAR = 10n ** 24n;

function toYocto(near: string): bigint {
  const [whole, frac = ""] = near.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt((frac + "0".repeat(24)).slice(0, 24));
}

export function gullibleInjectablePlanner(trigger: string): Intent | null {
  const matches = [...trigger.matchAll(/pay\s+(\d+(?:\.\d{1,24})?)\s+NEAR\s+to\s+([a-z0-9._-]+)/gi)];
  const last = matches.at(-1); // the last instruction wins, which is what injection exploits
  // Sentence punctuation is not part of an account id ("...to supplier.testnet.").
  return last ? { amount: toYocto(last[1]), receiver: last[2].toLowerCase().replace(/[._-]+$/, "") } : null;
}
