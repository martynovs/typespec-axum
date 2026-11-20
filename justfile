# Build the emitter, then regenerate and format the example's Rust and OpenAPI.
default:
    @just --list

install:
    bun install

build:
    bun run build

typecheck:
    bun run typecheck

# The example's generated files (committed, so a diff shows what a change to the emitter does to them).
generate: build
    bun x tsp compile examples/pets --config examples/pets/tspconfig.yaml
    rustfmt --edition 2024 examples/pets/generated/rust/types.rs examples/pets/generated/rust/axum.rs

# Format the example's own sources (the generated files are formatted by `generate`).
fmt:
    rustfmt --edition 2024 examples/pets/src/main.rs examples/pets/src/store.rs examples/pets/tests/api.rs

# Compile and run the example's tests, which also check its document against @typespec/openapi3's.
test: generate
    cargo test --manifest-path examples/pets/Cargo.toml

# Compile the contracts of tests/probes: each is emitted and built, or refused with the diagnostic it names.
probes: build
    tests/probes.sh
    DOCUMENT=typespec tests/probes.sh

# Serve the example on 127.0.0.1:3000.
serve: generate
    cargo run --manifest-path examples/pets/Cargo.toml

# Fail when the committed generated files are not what the emitter writes.
check: generate
    git diff --exit-code -- examples/pets/generated
