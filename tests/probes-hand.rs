//! Types a probe contract leaves to the application (`type-map`): copied into the probes crate as `crate::hand`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct Limits {
    #[serde(default)]
    pub max: Option<String>,
    #[serde(default)]
    pub min: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct Bounds {
    #[serde(default)]
    pub price: Limits,
}

/// Its `Debug` hides the secret.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct Minted(pub String);

impl std::fmt::Debug for Minted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Minted(..)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Red,
    Green,
}

/// What an extension of an operation says the operation demands, made at compile time by `guard!`.
#[derive(Debug, PartialEq, Eq)]
pub enum Scope {
    Read,
    Deposit,
    Withdraw,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Demand {
    pub scope: &'static [Scope],
    pub binds: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Guarding {
    Unguarded,
    Demand(Demand),
}

macro_rules! scope {
    ("read") => { $crate::hand::Scope::Read };
    ("deposit") => { $crate::hand::Scope::Deposit };
    ("withdraw") => { $crate::hand::Scope::Withdraw };
}

macro_rules! guard {
    ("none") => { $crate::hand::Guarding::Unguarded };
    ({ "scope": [ $($s:tt),* ] $(, "binds": $b:literal)? }) => {
        $crate::hand::Guarding::Demand($crate::hand::Demand { scope: &[ $( $crate::hand::scope!($s) ),* ], binds: $crate::hand::guard!(@binds $($b)?) })
    };
    ({ "scope": $s:tt $(, "binds": $b:literal)? }) => {
        $crate::hand::Guarding::Demand($crate::hand::Demand { scope: &[ $crate::hand::scope!($s) ], binds: $crate::hand::guard!(@binds $($b)?) })
    };
    (@binds) => { None };
    (@binds $b:literal) => { Some($b) };
}

pub(crate) use guard;
pub(crate) use scope;

/// What a request that cannot be read is refused with: the status and the cause, in a body of the application's own.
#[derive(Debug)]
pub struct Rejected(pub axum::http::StatusCode, pub &'static str);

impl axum::response::IntoResponse for Rejected {
    fn into_response(self) -> axum::response::Response {
        (self.0, format!("rejected {}: {}", self.0.as_u16(), self.1)).into_response()
    }
}

pub fn reject(status: axum::http::StatusCode, message: &'static str) -> Rejected {
    Rejected(status, message)
}

/// A number the application writes: `Eq`, and no `Hash`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct Money(pub i64);

impl std::fmt::Display for Money {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// The application's own type for a contract's `Wire.Limits`: the document names a schema by the Rust name, so it has a name of its own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct WireLimits {
    #[serde(default)]
    pub max: Option<String>,
}

/// A mapped model the contract declares and no operation reaches: the document still lists it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(no_document), derive(utoipa::ToSchema))]
pub struct Unused {
    #[serde(default)]
    pub a: Option<String>,
}

/// A type of no `ToSchema`: the entry says it is `inline`, so the document takes its schema from `PartialSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Opaque(pub String);

impl std::fmt::Display for Opaque {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(not(no_document))]
impl utoipa::PartialSchema for Opaque {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::ObjectBuilder::new().schema_type(utoipa::openapi::schema::Type::String).description(Some("opaque")).into()
    }
}
