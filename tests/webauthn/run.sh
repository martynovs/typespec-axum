#!/usr/bin/env bash
# The real WebAuthn types (webauthn-rs-proto) as the bodies and answers of a generated server, in a document of `derived` or `typespec`
# (default both): the contract is emitted with each of the four challenge types mapped with `schema: contract` and `partial-eq: false`,
# built against the library, served with real JSON, and its document checked. `just webauthn` runs it.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
for mode in ${@:-derived typespec}; do
  work="$root/tmp/webauthn-$mode"
  rm -rf "$work/out"
  mkdir -p "$work/contract" "$work/crate/src" "$work/crate/tests"
  cp "$root/tests/webauthn/main.tsp" "$work/contract/main.tsp"
  cp "$root/tests/webauthn/crate/Cargo.toml" "$work/crate/Cargo.toml"
  cp "$root/tests/webauthn/crate/tests/smoke.rs" "$work/crate/tests/smoke.rs"
  opt() { echo --option "@martynovs/typespec-rust-api.$1"; }
  maps=()
  for type in CreationChallengeResponse RegisterPublicKeyCredential RequestChallengeResponse PublicKeyCredential; do
    maps+=(--option "@martynovs/typespec-rust-api.type-map.$type.path=webauthn_rs_proto::$type"
      --option "@martynovs/typespec-rust-api.type-map.$type.schema=contract"
      --option "@martynovs/typespec-rust-api.type-map.$type.partial-eq=false")
  done
  (cd "$root" && bun x tsp compile "$work/contract" --emit "$root" --output-dir "$work/out" \
    --option "@martynovs/typespec-rust-api.types-path=crate::gateway::types" \
    --option "@martynovs/typespec-rust-api.document=$mode" --option "@martynovs/typespec-rust-api.client=true" \
    --option "@martynovs/typespec-rust-api.client-path=crate::gateway::client" "${maps[@]}")
  rust=$(dirname "$(find "$work/out" -name types.rs | head -1)")
  cat >"$work/crate/src/lib.rs" <<EOF
pub mod gateway {
    #[path = "$rust/types.rs"] pub mod types;
    #[path = "$rust/axum.rs"] pub mod api;
    #[path = "$rust/client.rs"] pub mod client;
}
EOF
  echo "== webauthn, document: $mode"
  RUSTFLAGS="-D warnings" cargo test --manifest-path "$work/crate/Cargo.toml" 2>&1 | tail -25
done
