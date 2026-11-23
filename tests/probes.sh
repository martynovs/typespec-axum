#!/usr/bin/env bash
# Compile every contract of tests/probes with the emitter. One with a refuse.txt must be refused with a diagnostic holding that text;
# the others are emitted, compiled together as modules of one crate, and each service's document() is built. `just probes` runs it;
# DOCUMENT=typespec runs it with the emitter's `document` option set to that (default `derived`).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/.probes${DOCUMENT:+-$DOCUMENT}"
cd "$root"
mkdir -p "$work/crate/src"
failed=0
modules=()
indent() { tail -8 "$1" | while IFS= read -r line; do echo "    $line"; done; }
mode=${DOCUMENT:-derived}
for dir in tests/probes/*/; do
  name=$(basename "$dir")
  # `only.txt` names the document modes a probe is for (a probe whose refusal is about a document is for `derived` and `typespec`).
  if [ -f "$dir/only.txt" ] && ! grep -qw -- "$mode" "$dir/only.txt"; then continue; fi
  # `options.txt` holds more emitter options, one `name=value` per line.
  extra=()
  # `no-irpc.txt` leaves the irpc protocol out of a probe (the contract has what a protocol cannot carry).
  irpc=(); [ -f "$dir/no-irpc.txt" ] || irpc=(--option "@martynovs/typespec-rust-api.irpc=true")
  if [ -f "$dir/options.txt" ]; then
    while IFS= read -r line; do [ -n "$line" ] && extra+=(--option "@martynovs/typespec-rust-api.$line"); done <"$dir/options.txt"
  fi
  id=${name//-/_}
  out="$work/$name"
  log="$work/$name.log"
  rm -rf "$out"
  if bun x tsp compile "$dir" --emit "$root" --output-dir "$out" \
    --option "@martynovs/typespec-rust-api.types-path=crate::$id::types" \
    --option "@martynovs/typespec-rust-api.document=$mode" --option "@martynovs/typespec-rust-api.client=true" --option "@martynovs/typespec-rust-api.client-path=crate::$id::client" ${irpc[@]+"${irpc[@]}"} ${extra[@]+"${extra[@]}"} >"$log" 2>&1; then compiled=1; else compiled=0; fi
  if [ -f "$dir/refuse.txt" ]; then
    want=$(cat "$dir/refuse.txt")
    if [ "$compiled" = 1 ] || ! grep -qF -- "$want" "$log"; then
      echo "FAIL $name: expected a refusal holding \"$want\""; indent "$log"; failed=1
    else echo "ok   $name (refused)"; fi
  elif [ "$compiled" = 0 ]; then
    echo "FAIL $name: the emit failed"; indent "$log"; failed=1
  else
    module=probe; [ -f "$dir/module.txt" ] && module=$(cat "$dir/module.txt")
    rust=$(dirname "$(find "$out" -name types.rs | head -1)")
    modules+=("$id|$module|$rust")
    echo "ok   $name"
  fi
done
[ "$failed" = 0 ] || exit 1

cp tests/probes-hand.rs "$work/crate/src/hand.rs"
{
  echo "pub mod hand;"
  for m in "${modules[@]}"; do
    IFS='|' read -r id module rust <<<"$m"
    api=""; [ -f "$rust/axum.rs" ] && api="#[path = \"$rust/axum.rs\"] pub mod api;"
    irpc_mod=""; [ -f "$rust/irpc.rs" ] && irpc_mod="#[path = \"$rust/irpc.rs\"] pub mod irpc_api;"
    echo "pub mod $id { #[path = \"$rust/types.rs\"] pub mod types; $api #[path = \"$rust/client.rs\"] pub mod client; $irpc_mod }"
  done
  if [ "${DOCUMENT:-derived}" != none ]; then
    echo "pub fn documents() -> Vec<(&'static str, serde_json::Value)> { vec!["
    for m in "${modules[@]}"; do
      IFS='|' read -r id module rust <<<"$m"
      [ -f "$rust/axum.rs" ] || continue
      echo "  (\"$id\", $id::api::$module::document()),"
    done
    echo "] }"
  fi
} >"$work/crate/src/lib.rs"
mkdir -p "$work/crate/tests"
cp tests/probes-behaviour.rs "$work/crate/tests/behaviour.rs"
documented=(); for m in "${modules[@]}"; do IFS='|' read -r id module rust <<<"$m"; [ -f "$rust/axum.rs" ] && documented+=("$id"); done
[ "${DOCUMENT:-derived}" = none ] || cat >"$work/crate/tests/documents.rs" <<RS
#[test]
fn every_probe_builds_its_document() {
    let documents = probes::documents();
    assert_eq!(documents.len(), ${#documented[@]});
    for (name, document) in documents {
        assert!(document["paths"].as_object().is_some_and(|paths| !paths.is_empty()), "{name} has no paths");
    }
}
RS
cat >"$work/crate/Cargo.toml" <<'TOML'
[package]
name = "probes"
version = "0.0.0"
edition = "2024"
publish = false

[workspace]

[dependencies]
axum = { version = "0.8", default-features = false, features = ["http1", "json", "tokio", "query", "matched-path"] }
form_urlencoded = "1"
percent-encoding = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["macros", "net", "rt-multi-thread"] }
tokio-stream = { version = "0.1", default-features = false }
tower = { version = "0.5", features = ["util"] }
http = "1"
irpc = { version = "1", default-features = false, features = ["derive", "rpc"] }
bytes = "1"
reqwest = { version = "0.12", default-features = false, features = ["stream"] }
utoipa = "6"

[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(no_document)', 'cfg(document_typespec)'] }
TOML
if [ "${DOCUMENT:-derived}" = none ]; then
  # No document means no utoipa: the crate must build without it.
  grep -v '^utoipa' "$work/crate/Cargo.toml" >"$work/crate/Cargo.toml.new" && mv "$work/crate/Cargo.toml.new" "$work/crate/Cargo.toml"
  export RUSTFLAGS="-D warnings --cfg no_document"
  export RUSTDOCFLAGS="--cfg no_document"
else
  # A test of what only a `typespec` document says is for that mode.
  export RUSTFLAGS="-D warnings${DOCUMENT:+ --cfg document_$DOCUMENT}"
fi
[ -f "$work/crate/Cargo.lock" ] || cp examples/pets/Cargo.lock "$work/crate/Cargo.lock"
cargo test --manifest-path "$work/crate/Cargo.toml" 2>&1 | tail -25
