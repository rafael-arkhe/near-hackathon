#!/usr/bin/env bash
# Deploys and configures agent-vault on NEAR testnet with the near CLI (near-cli-rs).
# Run inside WSL/Linux by the account owner:
#   wsl -d Ubuntu -- bash /mnt/d/arkhe/hackathon/arkhe-guard/scripts/testnet-setup.sh
# Account keys are read from KEY_DIR (vault.key, agent.key: "ed25519:..."), copied into the
# CLI's file keychain (~/.near-credentials, mode 600) and never printed.
set -euo pipefail

# `wsl -- bash script.sh` is not a login shell, so cargo's bin dir may be missing from PATH.
export PATH="$HOME/.cargo/bin:$PATH"

KEY_DIR="${KEY_DIR:-/mnt/d/chaves/arkhe-guard}"
VAULT=arkhe-guard-vault.testnet
AGENT=arkhe-guard-agent.testnet
OWNER_KEY_HEX=fd278021a99d0a8d33181105458a2975bfbb5657ff0c616defef57fc18404e11
LOG_ID=arkhe-guard-testnet
LOG_KEY_HEX=c5b7872dcc63aaf78dcbd215d0bfc597cdf659a8df7d228bde8fef6b0834e492
WASM="$HOME/arkhe-guard-target/near/agent_vault/agent_vault.wasm"
CREDS="$HOME/.near-credentials/testnet"

command -v near >/dev/null || { echo "near CLI not found in this shell"; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found"; exit 1; }
[ -f "$WASM" ] || { echo "missing $WASM: run 'cargo near build non-reproducible-wasm' first"; exit 1; }

# Writes the CLI legacy-keychain file for an account from its key file. The public key is
# the last 32 bytes of the 64-byte ed25519 secret, base58-encoded.
import_key() {
  local account="$1" keyfile="$2"
  [ -f "$keyfile" ] || { echo "missing $keyfile"; exit 1; }
  mkdir -p "$CREDS" && chmod 700 "$HOME/.near-credentials" "$CREDS"
  ACCOUNT="$account" KEYFILE="$keyfile" OUT="$CREDS/$account.json" python3 - <<'PY'
import json, os
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s: n = n * 58 + A.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw
def b58e(b):
    n = int.from_bytes(b, "big"); out = ""
    while n: n, r = divmod(n, 58); out = A[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out
secret = open(os.environ["KEYFILE"]).read().strip()
assert secret.startswith("ed25519:"), "key file must contain ed25519:..."
raw = b58d(secret.split(":", 1)[1])
assert len(raw) == 64, "unexpected secret key length"
cred = {"account_id": os.environ["ACCOUNT"], "public_key": "ed25519:" + b58e(raw[32:]), "private_key": secret}
fd = os.open(os.environ["OUT"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(cred, f)
print(f"imported {cred['account_id']} ({cred['public_key'][:20]}...)")
PY
}

echo ">>> A. Import account keys from $KEY_DIR"
import_key "$VAULT" "$KEY_DIR/vault.key"
import_key "$AGENT" "$KEY_DIR/agent.key"

echo ">>> B. Deploy agent-vault to $VAULT"
near contract deploy "$VAULT" use-file "$WASM" with-init-call new \
  json-args "{\"owner_key_hex\":\"$OWNER_KEY_HEX\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

echo ">>> C. Register the evidence log key"
near contract call-function as-transaction "$VAULT" set_log_key \
  json-args "{\"log_id\":\"$LOG_ID\",\"key_hex\":\"$LOG_KEY_HEX\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$VAULT" network-config testnet sign-with-legacy-keychain send

echo ">>> D. Function-call key for the agent: only $VAULT.execute, 0.25 NEAR gas allowance"
near account add-key "$AGENT" grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id "$VAULT" --function-names 'execute' \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send

echo ">>> Done. Agent key files (the function-call one is for AGENT_FC_KEY_FILE):"
ls -1 "$CREDS/$AGENT"* 2>/dev/null
