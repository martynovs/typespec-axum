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
for dir in tests/probes/*/; do
  name=$(basename "$dir")
  id=${name//-/_}
  out="$work/$name"
  log="$work/$name.log"
  rm -rf "$out"
  if bun x tsp compile "$dir" --emit "$root" --output-dir "$out" \
    --option "@martynovs/typespec-axum.types-path=crate::$id::types" \
    --option "@martynovs/typespec-axum.document=${DOCUMENT:-derived}" >"$log" 2>&1; then compiled=1; else compiled=0; fi
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

{
  for m in "${modules[@]}"; do
    IFS='|' read -r id module rust <<<"$m"
    echo "pub mod $id { #[path = \"$rust/types.rs\"] pub mod types; #[path = \"$rust/axum.rs\"] pub mod api; }"
  done
  echo "pub fn documents() -> Vec<(&'static str, serde_json::Value)> { vec!["
  for m in "${modules[@]}"; do
    IFS='|' read -r id module rust <<<"$m"
    echo "  (\"$id\", $id::api::$module::document()),"
  done
  echo "] }"
} >"$work/crate/src/lib.rs"
mkdir -p "$work/crate/tests"
cp tests/probes-behaviour.rs "$work/crate/tests/behaviour.rs"
cat >"$work/crate/tests/documents.rs" <<RS
#[test]
fn every_probe_builds_its_document() {
    let documents = probes::documents();
    assert_eq!(documents.len(), ${#modules[@]});
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
utoipa = "6"
TOML
[ -f "$work/crate/Cargo.lock" ] || cp examples/pets/Cargo.lock "$work/crate/Cargo.lock"
RUSTFLAGS="-D warnings" cargo test --manifest-path "$work/crate/Cargo.toml" 2>&1 | tail -25
