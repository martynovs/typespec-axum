//! Two contracts of one shop: `web` (HTTP, for browsers and partners) and `rpc` (irpc, for the shop's own services), over the
//! models they share (`common`). Each is what `@martynovs/typespec-rust-api` wrote from its own project directory (see `just generate-split`).

#[path = "../generated/common"]
pub mod common {
    pub mod types;
}

#[path = "../generated/web"]
pub mod web {
    pub mod types;
    #[path = "axum.rs"]
    pub mod api;
}

#[path = "../generated/rpc"]
pub mod rpc {
    pub mod types;
    pub mod client;
    #[path = "irpc.rs"]
    pub mod irpc_api;
}
