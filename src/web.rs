//! WebOS adapter for the native garment template and CPU VBD/OGC engine.
use crate::{
    authoring::{self, Command, Edit, History},
    avatar::SurfaceMesh,
    garment::{
        CompiledGarment, GarmentTemplate,
        meshing::MeshingSettings,
        presets::{self, GarmentKind},
        seam::BoundaryRef,
    },
    model::State,
    vbd::{VbdSettings, VbdSolver},
};
use glam::{DVec2, DVec3};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SIMULATION_VERTICES: usize = 8_000;
const AVATAR: &str = include_str!("../assets/makehuman/mannequin.obj");

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WebEdit {
    Layout {
        panel: String,
        x: f64,
        y: f64,
        rotation: f64,
    },
    Place {
        panel: String,
        x: f64,
        y: f64,
        z: f64,
    },
    AddRectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    MoveAnchor {
        panel: String,
        anchor: usize,
        x: f64,
        y: f64,
    },
    RemovePanel {
        panel: String,
    },
    Sew {
        a: BoundaryRef,
        b: BoundaryRef,
        reverse: bool,
        ease: bool,
    },
    RemoveSeam {
        seam: String,
    },
}

#[wasm_bindgen]
pub struct Workspace {
    template: GarmentTemplate,
    garment: Arc<CompiledGarment>,
    state: State,
    history: History,
    avatar: SurfaceMesh,
    solver: Option<VbdSolver>,
}

fn error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

#[wasm_bindgen]
impl Workspace {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Workspace, JsValue> {
        let template = preset("tshirt")?;
        let garment = Arc::new(template.compile().map_err(error)?);
        let state = garment.initial_state.clone();
        let avatar = SurfaceMesh::parse_obj(AVATAR).map_err(error)?;
        Ok(Self {
            template,
            garment,
            state,
            history: History::default(),
            avatar,
            solver: None,
        })
    }

    pub fn avatar_json(&self) -> String {
        json!({"points": positions(&self.avatar.vertices), "faces": self.avatar.triangles})
            .to_string()
    }

    pub fn new_template(&mut self, name: &str) -> Result<(), JsValue> {
        self.replace(preset(name)?)
    }

    pub fn open(&mut self, source: &str) -> Result<(), JsValue> {
        if source.len() > MAX_FILE_BYTES {
            return Err(error("This garment exceeds the 2 MiB project limit."));
        }
        let template = serde_json::from_str(source).map_err(|e| error(e.to_string()))?;
        self.replace(template)
    }

    pub fn document(&self) -> Result<String, JsValue> {
        let encoded =
            serde_json::to_string_pretty(&self.template).map_err(|e| error(e.to_string()))?;
        if encoded.len() > MAX_FILE_BYTES {
            return Err(error("This garment exceeds the 2 MiB project limit."));
        }
        Ok(encoded + "\n")
    }

    pub fn edit(&mut self, source: &str) -> Result<Option<String>, JsValue> {
        let input = serde_json::from_str(source).map_err(|e| error(e.to_string()))?;
        let command = self.command(input)?;
        let edit = authoring::apply(&self.template, command).map_err(error)?;
        let selected = edit.selected.clone();
        self.history.record(self.template.clone());
        self.apply(edit);
        Ok(selected)
    }

    pub fn history(&mut self, redo: bool) -> Result<(), JsValue> {
        let edit = self.history.restore(&self.template, redo).map_err(error)?;
        self.apply(edit);
        Ok(())
    }

    pub fn view(&self) -> Result<String, JsValue> {
        let mut panels = Vec::new();
        for (index, (panel, compiled)) in self
            .template
            .panels
            .iter()
            .zip(&self.garment.panels)
            .enumerate()
        {
            let mut edges = Vec::new();
            let mut anchors = Vec::new();
            for (name, indices) in &compiled.boundaries {
                let coordinates: Vec<_> = indices
                    .iter()
                    .map(|&i| self.garment.mesh.uv[i].to_array())
                    .collect();
                edges.push(json!({"name":name,"points":coordinates}));
            }
            if let Some(polygon) = &panel.polygon {
                anchors.extend(polygon.points.iter().map(|p| p.to_array()));
            }
            let origin = authoring::layout(&self.template, index);
            let faces: Vec<_> = self.garment.mesh.triangles[compiled.triangles.clone()]
                .iter()
                .map(|t| t.vertices)
                .collect();
            panels.push(json!({
                "id":panel.id,"name":panel.name,"origin":origin.to_array(),
                "rotation":panel.layout_rotation_degrees,"placement":panel.placement.translation.to_array(),
                "edges":edges,"anchors":anchors,"faces":faces,
            }));
        }
        let rest: Vec<_> = self.garment.mesh.uv.iter().map(|p| p.to_array()).collect();
        Ok(json!({
            "name":self.template.name,"panels":panels,"rest":rest,
            "points":positions(&self.state.x),"seams":self.template.seams,
            "time":self.state.time,"canUndo":self.history.can_undo(),"canRedo":self.history.can_redo(),
        }).to_string())
    }

    pub fn reset_simulation(&mut self) {
        self.state = self.garment.initial_state.clone();
        self.solver = None;
    }

    pub fn step(&mut self) -> Result<String, JsValue> {
        if self.garment.mesh.uv.len() > MAX_SIMULATION_VERTICES {
            return Err(error("This mesh is too dense for the browser solver."));
        }
        if self.solver.is_none() {
            let solver = VbdSolver::new(self.garment.clone(), Some(&self.avatar), &self.state)
                .map_err(error)?;
            self.solver = Some(solver);
        }
        let settings = VbdSettings {
            dt: 1.0 / 120.0,
            iterations: 8,
            ..VbdSettings::default()
        };
        let old = self.state.clone();
        let solver = self.solver.as_mut().expect("solver initialized above");
        let result = solver.step(&mut self.state, &settings, None);
        let metrics = match result {
            Ok(value) => value,
            Err(message) => {
                self.state = old;
                self.solver = None;
                return Err(error(message));
            }
        };
        Ok(
            json!({"points":positions(&self.state.x),"time":self.state.time,
                  "contacts":metrics.contacts,"seamGap":metrics.max_seam_gap_m})
            .to_string(),
        )
    }
}

impl Workspace {
    fn replace(&mut self, template: GarmentTemplate) -> Result<(), JsValue> {
        if template.format != "marvelous-cloth-template" || !matches!(template.version, 1 | 2) {
            return Err(error(
                "Choose a ClothCraft garment template, version 1 or 2.",
            ));
        }
        let garment = template.compile().map_err(error)?;
        self.template = template;
        self.garment = Arc::new(garment);
        self.history = History::default();
        self.reset_simulation();
        Ok(())
    }

    fn apply(&mut self, edit: Edit) {
        if edit.reset_simulation {
            self.state = edit.state_after(&self.garment, &self.state);
            self.solver = None;
        }
        self.garment = Arc::new(edit.garment);
        self.template = edit.template;
    }

    fn command(&self, choice: WebEdit) -> Result<Command, JsValue> {
        Ok(match choice {
            WebEdit::Layout {
                panel,
                x,
                y,
                rotation,
            } => Command::BoardTransform {
                panel,
                origin: DVec2::new(x, y),
                rotation_degrees: rotation,
            },
            WebEdit::Place { panel, x, y, z } => {
                let mut placement = self
                    .template
                    .panels
                    .iter()
                    .find(|p| p.id == panel)
                    .ok_or_else(|| error("Select a pattern piece."))?
                    .placement
                    .clone();
                placement.translation = DVec3::new(x, y, z);
                Command::Place { panel, placement }
            }
            WebEdit::AddRectangle {
                x,
                y,
                width,
                height,
            } => {
                let fabric = self
                    .template
                    .fabrics
                    .first()
                    .ok_or_else(|| error("This garment has no fabric."))?;
                if !(0.02..=2.0).contains(&width) || !(0.02..=2.0).contains(&height) {
                    return Err(error("Use a panel width and height from 20 to 2,000 mm."));
                }
                let corner = DVec2::new(x, y);
                let points = vec![
                    corner,
                    corner + DVec2::new(width, 0.),
                    corner + DVec2::new(width, height),
                    corner + DVec2::new(0., height),
                ];
                Command::Polygon {
                    points,
                    tangents: vec![DVec2::ZERO; 4],
                    meshing: MeshingSettings {
                        target_edge_m: 0.045,
                        ..MeshingSettings::default()
                    },
                    fabric: fabric.id.clone(),
                    replace: false,
                }
            }
            WebEdit::MoveAnchor {
                panel,
                anchor,
                x,
                y,
            } => Command::Anchor {
                panel,
                anchor,
                position: DVec2::new(x, y),
            },
            WebEdit::RemovePanel { panel } => Command::RemovePanel { panel },
            WebEdit::Sew {
                a,
                b,
                reverse,
                ease,
            } => Command::Sew {
                a,
                b,
                reverse,
                ease,
            },
            WebEdit::RemoveSeam { seam } => Command::RemoveSeam { seam },
        })
    }
}

fn preset(name: &str) -> Result<GarmentTemplate, JsValue> {
    let kind = match name {
        "tshirt" => GarmentKind::Tshirt,
        "dress" => GarmentKind::Dress,
        _ => return Err(error("Choose the T-shirt or dress template.")),
    };
    let mut template = presets::basic(kind, 2);
    for panel in &mut template.panels {
        if let Some(mesh) = panel.polygon.as_mut().and_then(|p| p.meshing.as_mut()) {
            mesh.target_edge_m = 0.05;
        }
    }
    Ok(template)
}

fn positions(points: &[DVec3]) -> Vec<[f32; 3]> {
    points.iter().map(|p| p.as_vec3().to_array()).collect()
}
