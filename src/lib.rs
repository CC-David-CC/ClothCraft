//! SI units throughout: metres, kilograms, seconds, Newtons.
pub mod authoring;
pub mod avatar;
pub mod avatar_import;
pub mod avatar_measurements;
pub mod contact;
pub mod document;
pub mod energy;
pub mod fabrics;
pub mod fitting;
pub mod garment;
pub mod gltf_avatar;
#[cfg(feature = "desktop")]
pub mod gpu_vbd;
pub mod issue_report;
pub mod math;
pub mod model;
pub mod motion;
pub mod ogc;
pub mod pattern_import;
pub mod picking;
pub mod project;
/// Shared optional renderer; the numerical modules do not depend on this module.
#[cfg(feature = "desktop")]
pub mod render;
pub mod session_protocol;
pub mod solver;
pub mod solver_lab;
pub mod template_catalog;
pub mod vbd;

#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod web;

mod clock {
    #[cfg(not(target_arch = "wasm32"))]
    pub use std::time::Instant;
    #[cfg(target_arch = "wasm32")]
    pub use web_time::Instant;
}
