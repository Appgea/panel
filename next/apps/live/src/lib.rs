//! Panel Live's view: a dark map you drag and zoom, where coding agents are small electrons.
//! Panel's TypeScript lays the world out and hands it over with `set_scene`. Bevy only draws
//! it. Every word is HTML on top, so nothing here draws text.
//!
//! # The scene contract
//!
//! `live_scene.ts` writes this JSON and `Scene` below reads it. Change both together.
//! Positions are world pixels with y growing down. The hub, This Mac, sits at the origin.
//! Colours are hex strings like `#6fe7ff`.
//!
//! - `w`, `h`: the stage size in CSS pixels. `reduced`: the owner asked for reduced motion.
//!   Nothing blinks or glides then, and no effect plays.
//! - `camera`: the world point at the stage's centre and the `zoom`, 1 for one world pixel per
//!   CSS pixel. The owner drags and zooms it.
//! - `districts`: one rounded box per project with a running agent, `x`, `y` its centre and `w`,
//!   `h` its size, with its `edge` (`quiet`, `card`
//!   when an agent there waits for the owner, `stuck`) and `selected`. Other projects are not on
//!   the map.
//! - `hub`: This Mac's box, `hot` when macOS slowed the CPU, and its testlock `bays`.
//! - `landmarks`: GitHub (`tower`) and the `web`, each a card `w` by `h` beside This Mac, lit
//!   at the edge when it had news lately. A kind this build does not know draws nothing.
//! - `links`: lines from the hovered or selected dot to its parent and children.
//! - `dots`: the agents. Each keeps its id across scenes and glides to its new `x`, `y`. `r`
//!   is its core size, `state` its colour and blink, `helpers` the electrons circling it,
//!   `carry` the colour of a crate it holds, if any.
//! - `fx`: effects starting now, from the playbook (live_playbook.ts) and the animation scripts
//!   (live_script.ts): `orb`, `beam`, `pulse`, `ring`, `burst`, `sweep`, `orbit`. Each has `x`,
//!   `y`, and `x2`, `y2` where it travels, a `color`, a `size`, a length `ms`, a `count` and a
//!   `delay` in ms. An unknown kind draws nothing.
//!
//! # Modules
//!
//! Each draws one part and owns its own entities. `bg` the dot grid, `district` the districts,
//! `hub` This Mac, its bays and the landmarks, `link` family lines, `dot`
//! the agents, `fx` the effects. `draw` holds the shared parts. A module redraws when `Current`
//! changes, and asks `Pace` for the frame rate it needs. A still world draws four frames a
//! second at most, to pick up a new scene. A closed section draws nothing (`set_paused`).

mod bg;
mod district;
mod dot;
mod draw;
mod fx;
mod hub;
mod link;

use bevy::camera::ScalingMode;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;
use bevy::winit::{UpdateMode, WinitSettings};
use draw::{srgb, Pace, NIGHT, STILL};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use wasm_bindgen::prelude::*;

/// The newest scene from the page, taken by the next frame. Older ones are simply replaced.
static INBOX: Mutex<Option<String>> = Mutex::new(None);
/// The newest camera from the page. A drag sends many, each without the rest of the scene.
static CAMERA: Mutex<Option<Camera>> = Mutex::new(None);
/// Set while the Live section is closed. The loop then sleeps until a window event, and the
/// canvas growing back from zero size when the section reopens is that event.
static PAUSED: AtomicBool = AtomicBool::new(false);
const ASLEEP: Duration = Duration::from_secs(24 * 60 * 60);

#[wasm_bindgen]
pub fn set_scene(json: String) {
    if let Ok(mut inbox) = INBOX.lock() {
        *inbox = Some(json);
    }
}

/// Moves the view only. Cheap enough to call on every pointer move of a drag.
#[wasm_bindgen]
pub fn set_camera(x: f32, y: f32, zoom: f32) {
    if let Ok(mut c) = CAMERA.lock() {
        *c = Some(Camera { x, y, zoom });
    }
}

#[wasm_bindgen]
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

/// The order of a frame: take the new scene, draw, then set the next frame's wait.
/// A module adds its systems `.in_set(Step::Draw)`.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Step {
    Take,
    Draw,
    Pace,
}

/// Starts drawing into the canvas the selector names, like `#liveCanvas`.
#[wasm_bindgen]
pub fn start(canvas: String) {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                canvas: Some(canvas),
                fit_canvas_to_parent: true,
                prevent_default_event_handling: false,
                ..default()
            }),
            ..default()
        }))
        .insert_resource(ClearColor(srgb(NIGHT)))
        .insert_resource(WinitSettings {
            focused_mode: UpdateMode::reactive_low_power(STILL),
            unfocused_mode: UpdateMode::reactive_low_power(STILL),
        })
        .insert_resource(Pace { want: STILL })
        .insert_resource(draw::Dice(0x9E37_79B9_7F4A_7C15))
        .init_resource::<draw::Kit>()
        .init_resource::<draw::Frame>()
        .init_resource::<Current>()
        .configure_sets(Update, (Step::Take, Step::Draw.after(Step::Take), Step::Pace.after(Step::Draw)))
        .add_systems(Startup, camera)
        .add_systems(Update, (take_scene, take_camera).chain().in_set(Step::Take))
        .add_systems(Update, pace.in_set(Step::Pace))
        .add_plugins((bg::plugin, district::plugin, hub::plugin, link::plugin, dot::plugin, fx::plugin))
        .run();
}

/// The last scene the page sent. It changes only when a new one arrives.
#[derive(Resource, Default)]
pub(crate) struct Current(pub Scene);

#[derive(Deserialize, Default)]
pub(crate) struct Scene {
    pub w: f32,
    pub h: f32,
    #[serde(default)]
    pub reduced: bool,
    #[serde(default)]
    pub camera: Camera,
    #[serde(default)]
    pub districts: Vec<District>,
    #[serde(default)]
    pub hub: Option<Hub>,
    #[serde(default)]
    pub landmarks: Vec<Landmark>,
    #[serde(default)]
    pub links: Vec<Line>,
    #[serde(default)]
    pub dots: Vec<Dot>,
    #[serde(default)]
    pub fx: Vec<Fx>,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Camera {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Camera { x: 0.0, y: 0.0, zoom: 1.0 }
    }
}

#[derive(Deserialize, Clone)]
pub(crate) struct District {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub edge: Edge,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Edge {
    Quiet,
    Card,
    Stuck,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Hub {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    #[serde(default)]
    pub hot: bool,
    #[serde(default)]
    pub bays: Vec<Bay>,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Bay {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    #[serde(default)]
    pub held: bool,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Landmark {
    pub kind: LandmarkKind,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// No news here lately: a plain edge, so the map's light is where work happens.
    #[serde(default)]
    pub quiet: bool,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LandmarkKind {
    Tower,
    Web,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Line {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

impl Line {
    pub fn a(&self) -> Vec2 {
        Vec2::new(self.x1, self.y1)
    }
    pub fn b(&self) -> Vec2 {
        Vec2::new(self.x2, self.y2)
    }
}

#[derive(Deserialize, Clone)]
pub(crate) struct Dot {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub state: State,
    #[serde(default)]
    pub helpers: u32,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub hovered: bool,
    #[serde(default)]
    pub carry: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Work,
    Think,
    Turn,
    Idle,
    Stuck,
}

/// One effect, starting `delay` ms from now.
#[derive(Deserialize, Clone)]
pub(crate) struct Fx {
    pub kind: FxKind,
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub x2: Option<f32>,
    #[serde(default)]
    pub y2: Option<f32>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub size: Option<f32>,
    #[serde(default)]
    pub ms: Option<f32>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub delay: Option<f32>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FxKind {
    /// A glowing ball that travels from x, y to x2, y2 with a trail.
    Orb,
    /// A line of light from x, y to x2, y2 that fades.
    Beam,
    /// A soft glow that swells and fades.
    Pulse,
    /// A thin ring that grows and fades.
    Ring,
    /// Sparks flying out.
    Burst,
    /// A light that turns around the point, like a radar.
    Sweep,
    /// Small electrons circling the point.
    Orbit,
    /// A kind this build does not know yet. It draws nothing, and the rest of the scene stays.
    #[serde(other)]
    Unknown,
}

/// `#rrggbb` as a number, or white.
pub(crate) fn hex(s: Option<&str>) -> u32 {
    s.and_then(|s| u32::from_str_radix(s.trim_start_matches('#'), 16).ok()).unwrap_or(draw::INK)
}

/// No bloom and no tone mapping: the glow is our own soft disc (`draw::glow_disc`), and every
/// colour lands on screen exactly as its token.
fn camera(mut commands: Commands) {
    commands.spawn((Camera2d, Tonemapping::None));
}

fn take_scene(mut current: ResMut<Current>, mut frame: ResMut<draw::Frame>) {
    let Some(json) = INBOX.lock().ok().and_then(|mut inbox| inbox.take()) else { return };
    let scene = match serde_json::from_str::<Scene>(&json) {
        Ok(scene) => scene,
        Err(e) => {
            // live_scene.ts and `Scene` drifted apart. The stage keeps the last good scene.
            error!("Live scene rejected: {e}");
            return;
        }
    };
    *frame = draw::Frame { w: scene.w, h: scene.h };
    if let Ok(mut c) = CAMERA.lock() {
        c.get_or_insert(scene.camera);
    }
    current.0 = scene;
}

/// One world pixel is `zoom` CSS pixels of the stage, whatever the screen's pixel density says,
/// so the HTML words on top line up.
fn take_camera(mut pace: ResMut<Pace>, frame: Res<draw::Frame>, mut cams: Query<(&mut Transform, &mut Projection), With<Camera2d>>) {
    pace.want = STILL;
    let Some(c) = CAMERA.lock().ok().and_then(|mut c| c.take()) else { return };
    let Ok((mut t, mut projection)) = cams.single_mut() else { return };
    t.translation = Vec3::new(c.x, -c.y, t.translation.z);
    if let Projection::Orthographic(ortho) = projection.as_mut() {
        let z = c.zoom.max(0.05);
        ortho.scaling_mode = ScalingMode::Fixed { width: frame.w.max(1.0) / z, height: frame.h.max(1.0) / z };
    }
}

/// The frame rate follows what moves. Still glow costs nothing.
fn pace(mut settings: ResMut<WinitSettings>, pace: Res<Pace>, mut was: Local<Option<Duration>>) {
    let wait = if PAUSED.load(Ordering::Relaxed) { ASLEEP } else { pace.want };
    if *was == Some(wait) {
        return;
    }
    *was = Some(wait);
    let mode = UpdateMode::reactive_low_power(wait);
    settings.focused_mode = mode;
    settings.unfocused_mode = mode;
}
