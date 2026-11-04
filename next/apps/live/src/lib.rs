//! Panel Live's view. Panel's TypeScript lays the scene out in CSS pixels and hands it over with
//! `set_scene`. Bevy only draws it: rooms, family lines, glowing agent dots, the jobs they run,
//! the embers stopped agents leave, and the short effects the playbook asks for.
//!
//! Light means state. A still world draws a frame four times a second at most, to pick up a new
//! scene. Only a blink, a circling helper or an effect raises the rate, and only while it lasts.
//! A closed section draws nothing (`set_paused`).

use bevy::camera::{Hdr, ScalingMode};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use bevy::winit::{UpdateMode, WinitSettings};
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
const STILL: Duration = Duration::from_millis(250);
/// A blink is slow, so ten frames a second draw it smoothly enough.
const BLINKING: Duration = Duration::from_millis(100);
/// Effects and circling helpers move: about 30 frames a second.
const MOVING: Duration = Duration::from_millis(33);
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
        .insert_resource(ClearColor(srgb(0x0A0D13)))
        .insert_resource(WinitSettings {
            focused_mode: UpdateMode::reactive_low_power(STILL),
            unfocused_mode: UpdateMode::reactive_low_power(STILL),
        })
        .add_systems(Startup, setup)
        .add_systems(Update, (apply_scene, blink, orbit, play_fx, pace).chain())
        .run();
}

#[derive(Deserialize)]
struct Scene {
    w: f32,
    h: f32,
    rooms: Vec<RoomBox>,
    links: Vec<Link>,
    dots: Vec<Dot>,
    #[serde(default)]
    jobs: Vec<JobMark>,
    #[serde(default)]
    embers: Vec<EmberMark>,
    #[serde(default)]
    fx: Vec<Fx>,
    #[serde(default)]
    tether: Option<Line>,
}

#[derive(Deserialize)]
struct RoomBox {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    edge: Edge,
}

/// What a room's edge says: someone works in it, a card waits for you, or an agent is stuck.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Edge {
    Quiet,
    Work,
    Card,
    Stuck,
}

#[derive(Deserialize, Clone, Copy)]
struct Line {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

#[derive(Deserialize)]
struct Link {
    #[serde(flatten)]
    line: Line,
    /// `family` joins an agent to the one that started it. `job` joins a job to its agent.
    kind: LinkKind,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum LinkKind {
    Family,
    Job,
}

#[derive(Deserialize)]
struct Dot {
    x: f32,
    y: f32,
    r: f32,
    state: State,
    #[serde(default)]
    helpers: u32,
    #[serde(default)]
    selected: bool,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum State {
    Work,
    Think,
    Turn,
    Idle,
    Stuck,
}

#[derive(Deserialize)]
struct JobMark {
    x: f32,
    y: f32,
    /// `run` uses the CPU, `wait` idles, `left` lost its parent.
    look: JobLook,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum JobLook {
    Run,
    Wait,
    Left,
}

#[derive(Deserialize)]
struct EmberMark {
    x: f32,
    y: f32,
    cut: bool,
}

/// A one-shot effect from the playbook in live_playbook.ts.
#[derive(Deserialize, Clone, Copy)]
struct Fx {
    kind: FxKind,
    x: f32,
    y: f32,
    #[serde(default)]
    x2: f32,
    #[serde(default)]
    y2: f32,
    #[serde(default = "one")]
    r: f32,
}

fn one() -> f32 {
    6.0
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum FxKind {
    /// A new step: one soft ring.
    Pulse,
    /// One agent started another: a light runs along the line.
    Beam,
    /// An agent finished: a green flash where it stood.
    Done,
    /// An agent ended mid-step: a red flicker.
    Cut,
    /// Work went out: a wide green-blue ring.
    Ship,
    /// A card for you arrived from this room: an amber ring.
    Card,
}

/// Everything drawn from the last scene. A new scene replaces all of it.
#[derive(Component)]
struct Drawn;

/// A helper circling its agent.
#[derive(Component)]
struct Orbit {
    centre: Vec2,
    radius: f32,
    phase: f32,
}

/// A playing effect, with its own material so it can fade alone.
#[derive(Component)]
struct Playing {
    fx: Fx,
    began: f32,
    material: Handle<ColorMaterial>,
    /// The moving head of a beam.
    head: bool,
}

#[derive(Resource)]
struct Kit {
    square: Handle<Mesh>,
    circle: Handle<Mesh>,
    ring: Handle<Mesh>,
    wall: Handle<ColorMaterial>,
    edges: [Handle<ColorMaterial>; 4],
    family: Handle<ColorMaterial>,
    job_link: Handle<ColorMaterial>,
    tether: Handle<ColorMaterial>,
    selected: Handle<ColorMaterial>,
    helper: Handle<ColorMaterial>,
    jobs: [Handle<ColorMaterial>; 3],
    embers: [Handle<ColorMaterial>; 2],
    /// Core and three fading halos per state, in `State` order. Bloom blurs the steps into one
    /// soft glow. Turn and Stuck are shared, so one blink moves every dot in that state.
    dots: [(Handle<ColorMaterial>, [Handle<ColorMaterial>; 3]); 5],
}

const COLOURS: [(u32, f32); 5] = [(0x6FE7FF, 7.0), (0x93B4FF, 4.5), (0xFFB23F, 6.0), (0x6B7689, 0.9), (0xFF5A6A, 5.5)];
const HALO_ALPHA: [f32; 3] = [0.2, 0.09, 0.04];

fn srgb(hex: u32) -> Color {
    Color::srgb_u8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

/// A colour brighter than white in linear light, which the bloom pass turns into glow.
fn lit(hex: u32, gain: f32, alpha: f32) -> Color {
    let c = srgb(hex).to_linear();
    Color::LinearRgba(LinearRgba::new(c.red * gain, c.green * gain, c.blue * gain, alpha))
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    commands.spawn((Camera2d, Hdr, Tonemapping::AcesFitted, Bloom { intensity: 0.5, ..Bloom::NATURAL }));
    let mut flat = |color: Color| mats.add(ColorMaterial { color, alpha_mode: AlphaMode2d::Blend, ..default() });
    // An idle dot stays below white, so the bloom leaves it unlit.
    let dots = COLOURS.map(|(hex, gain)| {
        let halos = HALO_ALPHA.map(|alpha| flat(lit(hex, gain * 0.4, alpha)));
        (flat(lit(hex, gain, 1.0)), halos)
    });
    let kit = Kit {
        square: meshes.add(Rectangle::new(1.0, 1.0)),
        circle: meshes.add(Circle::new(1.0)),
        ring: meshes.add(Annulus::new(0.84, 1.0)),
        wall: flat(srgb(0x121721)),
        edges: [flat(srgb(0x232B39)), flat(lit(0x6FE7FF, 0.55, 1.0)), flat(lit(0xFFB23F, 0.9, 1.0)), flat(lit(0xFF5A6A, 0.9, 1.0))],
        family: flat(lit(0xE6EAF1, 0.7, 0.45)),
        job_link: flat(lit(0x6FE7FF, 0.5, 0.22)),
        tether: flat(lit(0xE6EAF1, 0.8, 0.35)),
        selected: flat(lit(0xE6EAF1, 1.4, 0.9)),
        helper: flat(lit(0x6FE7FF, 3.5, 1.0)),
        jobs: [flat(lit(0x6FE7FF, 1.1, 0.9)), flat(lit(0x8E98AB, 0.6, 0.8)), flat(lit(0xFFB23F, 0.9, 0.85))],
        embers: [flat(lit(0x4BE38F, 1.6, 0.75)), flat(lit(0xFF5A6A, 1.6, 0.75))],
        dots,
    };
    commands.insert_resource(kit);
}

#[derive(Resource, Default, Clone, Copy)]
struct Frame {
    w: f32,
    h: f32,
}

impl Frame {
    /// The page measures from the top left in CSS pixels. Bevy's 2D camera centres on the
    /// origin with y up.
    fn at(&self, x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x - self.w / 2.0, self.h / 2.0 - y, z)
    }
}

fn line(frame: Frame, l: Line, z: f32, width: f32) -> Transform {
    let (a, b) = (frame.at(l.x1, l.y1, z), frame.at(l.x2, l.y2, z));
    let d = b - a;
    Transform::from_translation((a + b) / 2.0)
        .with_rotation(Quat::from_rotation_z(d.y.atan2(d.x)))
        .with_scale(Vec3::new(d.truncate().length(), width, 1.0))
}

#[allow(clippy::too_many_arguments)]
fn apply_scene(
    mut commands: Commands,
    kit: Res<Kit>,
    time: Res<Time>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    old: Query<Entity, With<Drawn>>,
    mut camera: Query<&mut Projection, With<Camera2d>>,
    mut frame_res: Local<Option<Frame>>,
) {
    let Some(json) = INBOX.lock().ok().and_then(|mut inbox| inbox.take()) else { return };
    let scene = match serde_json::from_str::<Scene>(&json) {
        Ok(scene) => scene,
        Err(e) => {
            // live.ts and `Scene` drifted apart. The stage keeps the last good scene.
            error!("Live scene rejected: {e}");
            return;
        }
    };
    for e in &old {
        commands.entity(e).despawn();
    }
    let frame = Frame { w: scene.w, h: scene.h };
    *frame_res = Some(frame);
    commands.insert_resource(frame);
    // One world unit is one CSS pixel of the stage, whatever the screen's pixel density says,
    // so the HTML labels on top always line up.
    if let Ok(mut projection) = camera.single_mut() {
        if let Projection::Orthographic(ortho) = projection.as_mut() {
            ortho.scaling_mode = ScalingMode::Fixed { width: scene.w, height: scene.h };
        }
    }
    let mut orbits: Vec<Orbit> = Vec::new();
    let mut put = |mesh: &Handle<Mesh>, mat: &Handle<ColorMaterial>, t: Transform| {
        commands.spawn((Drawn, Mesh2d(mesh.clone()), MeshMaterial2d(mat.clone()), t));
    };
    for r in &scene.rooms {
        let centre = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let edge = &kit.edges[r.edge as usize];
        put(&kit.square, edge, Transform::from_translation(frame.at(centre.0, centre.1, 0.0)).with_scale(Vec3::new(r.w, r.h, 1.0)));
        put(&kit.square, &kit.wall, Transform::from_translation(frame.at(centre.0, centre.1, 0.1)).with_scale(Vec3::new(r.w - 2.0, r.h - 2.0, 1.0)));
    }
    for l in &scene.links {
        let (mat, width) = if l.kind == LinkKind::Family { (&kit.family, 1.2) } else { (&kit.job_link, 1.0) };
        put(&kit.square, mat, line(frame, l.line, 0.2, width));
    }
    if let Some(t) = scene.tether {
        put(&kit.square, &kit.tether, line(frame, t, 0.25, 1.0));
    }
    for j in &scene.jobs {
        let t = Transform::from_translation(frame.at(j.x, j.y, 0.3)).with_rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_4)).with_scale(Vec3::splat(5.0));
        put(&kit.square, &kit.jobs[j.look as usize], t);
    }
    for e in &scene.embers {
        put(&kit.circle, &kit.embers[e.cut as usize], Transform::from_translation(frame.at(e.x, e.y, 0.3)).with_scale(Vec3::splat(2.6)));
    }
    for d in &scene.dots {
        let (core, halos) = &kit.dots[d.state as usize];
        for (i, (halo, size)) in halos.iter().zip([1.9, 2.9, 4.4]).enumerate() {
            let z = 0.35 - i as f32 * 0.01;
            put(&kit.circle, halo, Transform::from_translation(frame.at(d.x, d.y, z)).with_scale(Vec3::splat(d.r * size)));
        }
        put(&kit.circle, core, Transform::from_translation(frame.at(d.x, d.y, 0.4)).with_scale(Vec3::splat(d.r)));
        if d.selected {
            put(&kit.ring, &kit.selected, Transform::from_translation(frame.at(d.x, d.y, 0.45)).with_scale(Vec3::splat(d.r * 2.3)));
        }
        let n = d.helpers.min(6);
        for i in 0..n {
            let centre = frame.at(d.x, d.y, 0.42).truncate();
            orbits.push(Orbit { centre, radius: d.r * 2.6, phase: i as f32 * std::f32::consts::TAU / n as f32 });
        }
    }
    for o in orbits {
        commands.spawn((
            Drawn,
            Mesh2d(kit.circle.clone()),
            MeshMaterial2d(kit.helper.clone()),
            Transform::from_translation(o.centre.extend(0.42)).with_scale(Vec3::splat(1.8)),
            o,
        ));
    }
    let now = time.elapsed_secs();
    for fx in scene.fx {
        let (hex, gain) = match fx.kind {
            FxKind::Pulse => (0x6FE7FF, 3.0),
            FxKind::Beam => (0xE6EAF1, 3.0),
            FxKind::Done | FxKind::Ship => (0x4BE38F, 4.0),
            FxKind::Cut => (0xFF5A6A, 4.0),
            FxKind::Card => (0xFFB23F, 3.5),
        };
        let mut spawn = |mesh: &Handle<Mesh>, head: bool| {
            let material = mats.add(ColorMaterial { color: lit(hex, gain, 0.0), alpha_mode: AlphaMode2d::Blend, ..default() });
            commands.spawn((
                Mesh2d(mesh.clone()),
                MeshMaterial2d(material.clone()),
                Transform::from_translation(frame.at(fx.x, fx.y, 0.5)).with_scale(Vec3::ZERO),
                Playing { fx, began: now, material, head },
            ));
        };
        match fx.kind {
            FxKind::Beam => {
                spawn(&kit.square, false);
                spawn(&kit.circle, true);
            }
            FxKind::Done | FxKind::Cut => spawn(&kit.circle, false),
            _ => spawn(&kit.ring, false),
        }
    }
}

/// Turn and Stuck dots blink by changing their shared materials: every waiting dot breathes
/// together, which reads calmer than many out of step.
fn blink(kit: Res<Kit>, time: Res<Time>, mut mats: ResMut<Assets<ColorMaterial>>, dots: Query<&MeshMaterial2d<ColorMaterial>, With<Drawn>>) {
    let t = time.elapsed_secs();
    for (state, period) in [(State::Turn as usize, 1.6), (State::Stuck as usize, 2.6)] {
        let (core, halos) = &kit.dots[state];
        if !dots.iter().any(|m| m.0 == *core) {
            continue;
        }
        let k = 0.55 + 0.45 * (0.5 + 0.5 * (t * std::f32::consts::TAU / period).cos());
        let (hex, gain) = COLOURS[state];
        if let Some(mut m) = mats.get_mut(core) {
            m.color = lit(hex, gain * k, 1.0);
        }
        for (h, a) in halos.iter().zip(HALO_ALPHA) {
            if let Some(mut m) = mats.get_mut(h) {
                m.color = lit(hex, gain * 0.4, a * k);
            }
        }
    }
}

fn orbit(time: Res<Time>, mut helpers: Query<(&Orbit, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (o, mut tf) in &mut helpers {
        let a = o.phase + t * 1.3;
        tf.translation.x = o.centre.x + o.radius * a.cos();
        tf.translation.y = o.centre.y + o.radius * a.sin();
    }
}

fn play_fx(
    mut commands: Commands,
    time: Res<Time>,
    frame: Option<Res<Frame>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    mut playing: Query<(Entity, &Playing, &mut Transform)>,
) {
    let Some(frame) = frame else { return };
    let now = time.elapsed_secs();
    for (e, p, mut tf) in &mut playing {
        let fx = p.fx;
        let length = match fx.kind {
            FxKind::Pulse => 0.7,
            FxKind::Beam => 1.0,
            FxKind::Ship => 1.4,
            _ => 1.0,
        };
        let k = ((now - p.began) / length).clamp(0.0, 1.0);
        if k >= 1.0 {
            commands.entity(e).despawn();
            mats.remove(&p.material);
            continue;
        }
        let fade = 1.0 - k;
        let (alpha, transform) = match fx.kind {
            FxKind::Pulse | FxKind::Card => (0.9 * fade, Transform::from_translation(frame.at(fx.x, fx.y, 0.5)).with_scale(Vec3::splat(fx.r * (1.4 + 2.4 * k)))),
            FxKind::Ship => (0.8 * fade, Transform::from_translation(frame.at(fx.x, fx.y, 0.5)).with_scale(Vec3::splat(fx.r * (2.0 + 6.0 * k)))),
            FxKind::Done => (0.85 * fade, Transform::from_translation(frame.at(fx.x, fx.y, 0.5)).with_scale(Vec3::splat(fx.r * (1.0 + 3.0 * k)))),
            FxKind::Cut => {
                let flicker = if (k * 9.0) as u32 % 2 == 0 { 1.0 } else { 0.25 };
                (0.9 * fade * flicker, Transform::from_translation(frame.at(fx.x, fx.y, 0.5)).with_scale(Vec3::splat(fx.r * 1.6)))
            }
            FxKind::Beam if p.head => {
                let run = (k / 0.7).min(1.0);
                let x = fx.x + (fx.x2 - fx.x) * run;
                let y = fx.y + (fx.y2 - fx.y) * run;
                (if run < 1.0 { 1.0 } else { fade }, Transform::from_translation(frame.at(x, y, 0.55)).with_scale(Vec3::splat(2.6)))
            }
            FxKind::Beam => (0.6 * fade, line(*frame, Line { x1: fx.x, y1: fx.y, x2: fx.x2, y2: fx.y2 }, 0.5, 1.6)),
        };
        *tf = transform;
        if let Some(mut m) = mats.get_mut(&p.material) {
            m.color = m.color.with_alpha(alpha);
        }
    }
}

/// The frame rate follows what moves. Still glow costs nothing.
fn pace(
    mut settings: ResMut<WinitSettings>,
    kit: Res<Kit>,
    playing: Query<(), With<Playing>>,
    orbits: Query<(), With<Orbit>>,
    dots: Query<&MeshMaterial2d<ColorMaterial>, With<Drawn>>,
    mut was: Local<Option<Duration>>,
) {
    let wait = if PAUSED.load(Ordering::Relaxed) {
        ASLEEP
    } else if !playing.is_empty() || !orbits.is_empty() {
        MOVING
    } else if dots.iter().any(|m| m.0 == kit.dots[State::Turn as usize].0 || m.0 == kit.dots[State::Stuck as usize].0) {
        BLINKING
    } else {
        STILL
    };
    if *was == Some(wait) {
        return;
    }
    *was = Some(wait);
    let mode = UpdateMode::reactive_low_power(wait);
    settings.focused_mode = mode;
    settings.unfocused_mode = mode;
}
