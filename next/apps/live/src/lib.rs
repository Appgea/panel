
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

static INBOX: Mutex<Option<String>> = Mutex::new(None);
static CAMERA: Mutex<Option<Camera>> = Mutex::new(None);
static PAUSED: AtomicBool = AtomicBool::new(false);
const ASLEEP: Duration = Duration::from_secs(24 * 60 * 60);

#[wasm_bindgen]
pub fn set_scene(json: String) {
    if let Ok(mut inbox) = INBOX.lock() {
        *inbox = Some(json);
    }
}

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

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Step {
    Take,
    Draw,
    Pace,
}

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
    #[serde(default)]
    pub px: f32,
    #[serde(default)]
    pub py: f32,
    #[serde(default)]
    pub hue: Option<String>,
    #[serde(default)]
    pub ringed: bool,
    #[serde(default)]
    pub bands: u32,
    #[serde(default)]
    pub trophies: u32,
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

pub(crate) const STATION: Vec2 = Vec2::new(36.0, 34.0);
pub(crate) const MARK_DX: f32 = 28.0;

impl Hub {
    pub fn station(&self) -> Vec2 {
        Vec2::new(self.x - self.w / 2.0 + STATION.x, self.y - self.h / 2.0 + STATION.y)
    }
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
    #[serde(default)]
    pub act: Option<String>,
    #[serde(default)]
    pub crew: Vec<State>,
    #[serde(default)]
    pub pings: u32,
    #[serde(default)]
    pub calls: u32,
    #[serde(default)]
    pub ship: Option<String>,
    #[serde(default)]
    pub tint: Option<String>,
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
    #[serde(default)]
    pub path: Option<Vec<[f32; 2]>>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FxKind {
    Orb,
    Beam,
    Pulse,
    Ring,
    Burst,
    Sweep,
    Orbit,
    #[serde(other)]
    Unknown,
}

pub(crate) fn hex(s: Option<&str>) -> u32 {
    s.and_then(|s| u32::from_str_radix(s.trim_start_matches('#'), 16).ok()).unwrap_or(draw::INK)
}

fn camera(mut commands: Commands) {
    commands.spawn((Camera2d, Tonemapping::None));
}

fn take_scene(mut current: ResMut<Current>, mut frame: ResMut<draw::Frame>) {
    let Some(json) = INBOX.lock().ok().and_then(|mut inbox| inbox.take()) else { return };
    let scene = match serde_json::from_str::<Scene>(&json) {
        Ok(scene) => scene,
        Err(e) => {
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
