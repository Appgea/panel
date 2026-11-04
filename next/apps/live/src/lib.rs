//! Panel Live's view. Panel's TypeScript lays the building out in CSS pixels and hands it over
//! with `set_scene`. Bevy only draws it. Every word is HTML on top, so nothing here draws text.
//! The target look is the concept page, next/apps/live/concept.html.
//!
//! # The scene contract
//!
//! `live_scene.ts` writes this JSON and `Scene` below reads it. Change both together.
//! All positions are stage CSS pixels from the top left. Colours are the concept's tokens.
//!
//! - `w`, `h`: the stage size. `reduced`: the owner asked for reduced motion. Nothing blinks or
//!   glides then, and blink alphas are fixed.
//! - `rooms`: the building's rooms, at most eight, in fixed places. Each has its box, `edge`
//!   (`quiet`, `card` when a card waits from it, `stuck` when an agent in it is stuck),
//!   `selected` when its panel is open, four station `pads` (Plan, Build, Check, Ship) as
//!   `[x, y]` centres with radii `pad_rx` and `pad_ry`, the `divider_y` under the sign, the
//!   `shelf_y` the embers stand on, and its `embers`, newest first, each with an `outcome`
//!   (`done`, `failed`, `crashed`, `stopped`, `stuck`).
//! - `base`: This Mac, a box with `hot` set when macOS slowed the CPU. `bays`: the testlock bay
//!   boxes inside it, `held` while a job holds one.
//! - `ring`: the owner's ring, a centre and radius, and `waiting` when any card waits. The
//!   card count is HTML.
//! - `threads`: one per card, a cubic bezier `p` of four `[x, y]` points from the card's agent
//!   or room down to the top of the ring. `front` marks the card the owner is reading.
//! - `flights`: lights that start now and travel a thread `p` in 1.1 s. `in` is a new card
//!   flying to the ring, `out` an answer flying back to the room.
//! - `links`: `family` lines from the hovered or selected dot to its parent and children, and
//!   `bay` lines from a bay holder's dot to its bay box.
//! - `dots`: every agent, by `id`. `x`, `y` is where the dot should stand: it glides there.
//!   `r` is the core radius by model tier, `state` (`work`, `think`, `turn`, `idle`, `stuck`),
//!   `helpers` circling it, and `selected` and `hovered`.
//! - `fx`: one-shot effects from the playbook (live_playbook.ts), starting now. `pulse`, `beam`
//!   (from x, y to x2, y2), `done`, `cut`, `ship`, `card`, `shipped` (a ring around the room box
//!   x, y to x2, y2), `clash` (a red line from x, y to x2, y2). An unknown kind draws nothing.
//! - `tether`: the line from the selected dot to its panel's edge, or null.
//!
//! # Modules
//!
//! Each draws one part and owns its own entities. `bg` the dot grid, `room` the rooms, pads,
//! shelves and embers, `base` This Mac, the bays and the ring, `link` family, bay, thread and
//! tether lines, `dot` the dots, `fx` the playbook effects and flights. `draw` holds the shared
//! parts. A module redraws when `Current` changes, and asks `Pace` for the frame rate it needs.
//!
//! A still world draws four frames a second at most, to pick up a new scene. A closed section
//! draws nothing (`set_paused`).

mod base;
mod bg;
mod dot;
mod draw;
mod fx;
mod link;
mod room;

use bevy::camera::ScalingMode;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;
use bevy::winit::{UpdateMode, WinitSettings};
use draw::{srgb, Frame, Pace, NIGHT, STILL};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use wasm_bindgen::prelude::*;

/// The newest scene from the page, taken by the next frame. Older ones are simply replaced.
static INBOX: Mutex<Option<String>> = Mutex::new(None);
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
        .init_resource::<Frame>()
        .init_resource::<Current>()
        .configure_sets(Update, (Step::Take, Step::Draw.after(Step::Take), Step::Pace.after(Step::Draw)))
        .add_systems(Startup, camera)
        .add_systems(Update, take_scene.in_set(Step::Take))
        .add_systems(Update, pace.in_set(Step::Pace))
        .add_plugins((bg::plugin, room::plugin, base::plugin, link::plugin, dot::plugin, fx::plugin))
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
    pub rooms: Vec<Room>,
    #[serde(default)]
    pub base: Option<Base>,
    #[serde(default)]
    pub bays: Vec<Bay>,
    #[serde(default)]
    pub ring: Option<Ring>,
    #[serde(default)]
    pub threads: Vec<Thread>,
    #[serde(default)]
    pub flights: Vec<Flight>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub dots: Vec<Dot>,
    #[serde(default)]
    pub fx: Vec<Fx>,
    #[serde(default)]
    pub tether: Option<Line>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Room {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub edge: Edge,
    #[serde(default)]
    pub selected: bool,
    pub pads: Vec<[f32; 2]>,
    pub pad_rx: f32,
    pub pad_ry: f32,
    pub divider_y: f32,
    pub shelf_y: f32,
    #[serde(default)]
    pub embers: Vec<Ember>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Edge {
    Quiet,
    Card,
    Stuck,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Ember {
    pub x: f32,
    pub y: f32,
    pub outcome: Outcome,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Outcome {
    Done,
    Failed,
    Crashed,
    Stopped,
    Stuck,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Base {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    #[serde(default)]
    pub hot: bool,
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
pub(crate) struct Ring {
    pub x: f32,
    pub y: f32,
    pub r: f32,
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Thread {
    pub p: [[f32; 2]; 4],
    #[serde(default)]
    pub front: bool,
}

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Flight {
    pub dir: Dir,
    pub p: [[f32; 2]; 4],
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Dir {
    In,
    Out,
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

#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Link {
    #[serde(flatten)]
    pub line: Line,
    pub kind: LinkKind,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LinkKind {
    Family,
    Bay,
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

/// A one-shot effect from the playbook in live_playbook.ts.
#[derive(Deserialize, Clone, Copy)]
pub(crate) struct Fx {
    pub kind: FxKind,
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub x2: f32,
    #[serde(default)]
    pub y2: f32,
    #[serde(default = "six")]
    pub r: f32,
}

fn six() -> f32 {
    6.0
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FxKind {
    /// A new step: one soft pulse.
    Pulse,
    /// One agent started another: a light runs along the line.
    Beam,
    /// An agent finished: green sparks where it stood.
    Done,
    /// An agent failed or ended mid-step: red sparks and a flicker.
    Cut,
    /// An agent starts a commit or a release.
    Ship,
    /// A card for you arrived from this room.
    Card,
    /// A release went out: a ring of light opens around the room box.
    Shipped,
    /// Two agents write one file: a red line between their dots.
    Clash,
    /// A kind this build does not know yet. It draws nothing, and the rest of the scene stays.
    #[serde(other)]
    Unknown,
}

/// No bloom and no tone mapping: the glow is the concept's own soft disc (`draw::glow_disc`), and
/// every colour lands on screen exactly as the concept's token.
fn camera(mut commands: Commands) {
    commands.spawn((Camera2d, Tonemapping::None));
}

fn take_scene(mut current: ResMut<Current>, mut frame: ResMut<Frame>, mut pace: ResMut<Pace>, mut camera: Query<&mut Projection, With<Camera2d>>) {
    pace.want = STILL;
    let Some(json) = INBOX.lock().ok().and_then(|mut inbox| inbox.take()) else { return };
    let scene = match serde_json::from_str::<Scene>(&json) {
        Ok(scene) => scene,
        Err(e) => {
            // live_scene.ts and `Scene` drifted apart. The stage keeps the last good scene.
            error!("Live scene rejected: {e}");
            return;
        }
    };
    *frame = Frame { w: scene.w, h: scene.h };
    // One world unit is one CSS pixel of the stage, whatever the screen's pixel density says,
    // so the HTML words on top always line up.
    if let Ok(mut projection) = camera.single_mut() {
        if let Projection::Orthographic(ortho) = projection.as_mut() {
            ortho.scaling_mode = ScalingMode::Fixed { width: scene.w, height: scene.h };
        }
    }
    current.0 = scene;
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
