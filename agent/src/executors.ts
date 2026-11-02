// Two VaultExecutors: the real one (agent-vault on NEAR, called with a function-call key)
// and an offline simulator of the same checks for tests and the no-network demo.
import { verify, type KeyObject } from "node:crypto";
import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
import { mandateId, mandatePayload, MANDATE_PROFILE, type Mandate } from "./mandate.ts";
import type { VaultExecutor } from "./guard.ts";

export class NearVaultExecutor implements VaultExecutor {
  readonly vaultId: string;
  readonly account: Account;
  readonly provider: JsonRpcProvider;

  /** agentKey should be a function-call key restricted to vaultId / ["execute"]. */
  constructor(rpcUrl: string, agentId: string, agentKey: KeyPairString, vaultId: string) {
    this.vaultId = vaultId;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.account = new Account(agentId, this.provider, agentKey);
  }

  async execute(mandate: Mandate, signatureHex: string, receiver: string, amount: bigint): Promise<string> {
    const args = { mandate, signature_hex: signatureHex, receiver, amount: amount.toString() };
    // Zero deposit: a function-call access key cannot attach one.
    const outcome = await this.account.signAndSendTransaction({
      receiverId: this.vaultId,
      actions: [actions.functionCall("execute", args, teraToGas("30"), 0n)],
      throwOnFailure: true
    });
    return outcome.transaction.hash;
  }

  async spent(mandateIdHex: string): Promise<bigint> {
    const value = await this.provider.callFunction({ contractId: this.vaultId, method: "get_spent", args: { mandate_id_hex: mandateIdHex } });
    return BigInt(value as string);
  }
}

/** Offline mirror of agent-vault.execute; the deployed contract stays the authority. */
export class SimulatedVault implements VaultExecutor {
  readonly vaultId: string;
  readonly agentId: string;
  readonly ownerKey: KeyObject;
  balance: bigint;
  readonly spentById = new Map<string, bigint>();
  readonly transfers: { receiver: string; amount: bigint }[] = [];
  now: () => bigint;
  private tx = 0;

  constructor(vaultId: string, agentId: string, ownerPublicKey: KeyObject, balance: bigint, now: () => bigint) {
    if (ownerPublicKey.type !== "public") throw new TypeError("simulator takes the owner's public key only");
    this.vaultId = vaultId; this.agentId = agentId; this.ownerKey = ownerPublicKey;
    this.balance = balance; this.now = now;
  }

  async execute(m: Mandate, signatureHex: string, receiver: string, amount: bigint): Promise<string> {
    const fail = (msg: string) => { throw new Error(`Smart contract panicked: ${msg}`); };
    const id = mandateId(m);
    if (m.profile !== MANDATE_PROFILE) fail("unsupported mandate profile");
    if (m.vault !== this.vaultId) fail("mandate is for another vault");
    if (m.agent !== this.agentId) fail("caller is not the mandated agent");
    if (!/^[0-9a-f]{128}$/.test(signatureHex) || !verify(null, mandatePayload(m), this.ownerKey, Buffer.from(signatureHex, "hex"))) fail("mandate signature invalid");
    const now = this.now();
    if (!(now >= BigInt(m.not_before_ns) && now < BigInt(m.expires_at_ns))) fail("mandate not active");
    if (m.allowed_receivers.length === 0 || m.allowed_receivers.length > 16) fail("mandate receiver list invalid");
    if (!m.allowed_receivers.includes(receiver)) fail("receiver not allowed by mandate");
    if (amount <= 0n || amount > BigInt(m.max_per_call)) fail("amount exceeds per-call limit");
    const total = (this.spentById.get(id) ?? 0n) + amount;
    if (total > BigInt(m.max_total)) fail("mandate budget exhausted");
    if (this.balance < amount) fail("vault balance too low");
    this.spentById.set(id, total);
    this.balance -= amount;
    this.transfers.push({ receiver, amount });
    return `simulated-tx-${++this.tx}`;
  }

  async spent(mandateIdHex: string): Promise<bigint> {
    return this.spentById.get(mandateIdHex) ?? 0n;
  }
}
