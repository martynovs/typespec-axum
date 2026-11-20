//! A pet store served from `main.tsp`: `generated/rust` is what `typespec-axum` wrote, `store` is the handlers.
#[path = "../generated/rust/axum.rs"]
pub mod api;
pub mod store;
#[path = "../generated/rust/types.rs"]
pub mod types;
