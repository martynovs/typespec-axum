//! A pet store served from `main.tsp`: `generated/rust` is what `@martynovs/typespec-rust-api` wrote, `store` is the handlers.
#[path = "../generated/rust/axum.rs"]
pub mod api;
#[path = "../generated/rust/client.rs"]
pub mod client;
#[path = "../generated/rust/irpc.rs"]
pub mod irpc_api;
pub mod store;
#[path = "../generated/rust/types.rs"]
pub mod types;
