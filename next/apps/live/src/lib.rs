//! Panel Live's view. Panel's TypeScript lays the scene out in CSS pixels and hands it over with
//! `set_scene`. Bevy only draws it: rooms, parent lines and glowing agent dots.
//!
//! The app is reactive: it wakes four times a second to pick up a new scene, and not at all
//! while the section is closed (`set_paused`).

use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::camera::{Hdr, ScalingMode};
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
const AWAKE: Duration = Duration::from_millis(250);
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

fn pace(mut settings: ResMut<WinitSettings>, mut was: Local<bool>) {
    let paused = PAUSED.load(Ordering::Relaxed);
    if paused == *was {
        return;
    }
    *was = paused;
    let mode = UpdateMode::reactive_low_power(if paused { ASLEEP } else { AWAKE });
    settings.focused_mode = mode;
    settings.unfocused_mode = mode;
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
            focused_mode: UpdateMode::reactive_low_power(AWAKE),
            unfocused_mode: UpdateMode::reactive_low_power(AWAKE),
        })
        .add_systems(Startup, setup)
        .add_systems(Update, (pace, apply_scene))
        .run();
}

#[derive(Deserialize)]
struct Scene {
    w: f32,
    h: f32,
    rooms: Vec<RoomBox>,
    links: Vec<Link>,
    dots: Vec<Dot>,
}

#[derive(Deserialize)]
struct RoomBox {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    /// A room with an agent at work gets a lit edge.
    hot: bool,
}

#[derive(Deserialize)]
struct Link {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

#[derive(Deserialize)]
struct Dot {
    x: f32,
    y: f32,
    r: f32,
    state: State,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum State {
    Work,
    Wait,
    Idle,
    Fail,
}

/// Everything drawn from the last scene. A new scene replaces all of it.
#[derive(Component)]
struct Drawn;

#[derive(Resource)]
struct Kit {
    square: Handle<Mesh>,
    circle: Handle<Mesh>,
    wall: Handle<ColorMaterial>,
    edge: Handle<ColorMaterial>,
    hot_edge: Handle<ColorMaterial>,
    link: Handle<ColorMaterial>,
    /// Core and three fading halos per state, in `State` order. Bloom blurs the steps into one
    /// soft glow.
    dots: [(Handle<ColorMaterial>, [Handle<ColorMaterial>; 3]); 4],
}

fn srgb(hex: u32) -> Color {
    Color::srgb_u8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

/// A colour brighter than white in linear light, which the bloom pass turns into glow.
fn lit(hex: u32, gain: f32, alpha: f32) -> Color {
    let c = srgb(hex).to_linear();
    Color::LinearRgba(LinearRgba::new(c.red * gain, c.green * gain, c.blue * gain, alpha))
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    commands.spawn((
        Camera2d,
        Hdr,
        Tonemapping::AcesFitted,
        Bloom { intensity: 0.5, ..Bloom::NATURAL },
    ));
    let mut flat = |color: Color| mats.add(ColorMaterial { color, alpha_mode: AlphaMode2d::Blend, ..default() });
    // An idle dot stays below white, so the bloom leaves it unlit. Only working, waiting and
    // stuck dots glow.
    let looks = [(0x6FE7FF, 7.0), (0xFFB23F, 6.0), (0x6B7689, 0.9), (0xFF5A6A, 5.5)];
    let dots = looks.map(|(hex, gain)| {
        let halos = [0.2, 0.09, 0.04].map(|alpha| flat(lit(hex, gain * 0.4, alpha)));
        (flat(lit(hex, gain, 1.0)), halos)
    });
    let kit = Kit {
        square: meshes.add(Rectangle::new(1.0, 1.0)),
        circle: meshes.add(Circle::new(1.0)),
        wall: flat(srgb(0x121721)),
        edge: flat(srgb(0x232B39)),
        hot_edge: flat(lit(0x6FE7FF, 0.55, 1.0)),
        link: flat(lit(0xE6EAF1, 0.7, 0.45)),
        dots,
    };
    commands.insert_resource(kit);
}

fn apply_scene(
    mut commands: Commands,
    kit: Res<Kit>,
    old: Query<Entity, With<Drawn>>,
    mut camera: Query<&mut Projection, With<Camera2d>>,
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
    // One world unit is one CSS pixel of the stage, whatever the screen's pixel density says,
    // so the HTML labels on top always line up.
    if let Ok(mut projection) = camera.single_mut() {
        if let Projection::Orthographic(ortho) = projection.as_mut() {
            ortho.scaling_mode = ScalingMode::Fixed { width: scene.w, height: scene.h };
        }
    }
    // The page measures from the top left in CSS pixels. Bevy's 2D camera centres on the origin
    // with y up.
    let at = |x: f32, y: f32, z: f32| Vec3::new(x - scene.w / 2.0, scene.h / 2.0 - y, z);
    let mut put = |mesh: &Handle<Mesh>, mat: &Handle<ColorMaterial>, t: Transform| {
        commands.spawn((Drawn, Mesh2d(mesh.clone()), MeshMaterial2d(mat.clone()), t));
    };
    for r in &scene.rooms {
        let centre = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let edge = if r.hot { &kit.hot_edge } else { &kit.edge };
        put(&kit.square, edge, Transform::from_translation(at(centre.0, centre.1, 0.0)).with_scale(Vec3::new(r.w, r.h, 1.0)));
        put(&kit.square, &kit.wall, Transform::from_translation(at(centre.0, centre.1, 0.1)).with_scale(Vec3::new(r.w - 2.0, r.h - 2.0, 1.0)));
    }
    for l in &scene.links {
        let (a, b) = (at(l.x1, l.y1, 0.2), at(l.x2, l.y2, 0.2));
        let d = b - a;
        let t = Transform::from_translation((a + b) / 2.0)
            .with_rotation(Quat::from_rotation_z(d.y.atan2(d.x)))
            .with_scale(Vec3::new(d.truncate().length(), 1.2, 1.0));
        put(&kit.square, &kit.link, t);
    }
    for d in &scene.dots {
        let (core, halos) = &kit.dots[d.state as usize];
        for (i, (halo, size)) in halos.iter().zip([1.9, 2.9, 4.4]).enumerate() {
            let z = 0.3 - i as f32 * 0.01;
            put(&kit.circle, halo, Transform::from_translation(at(d.x, d.y, z)).with_scale(Vec3::splat(d.r * size)));
        }
        put(&kit.circle, core, Transform::from_translation(at(d.x, d.y, 0.4)).with_scale(Vec3::splat(d.r)));
    }
}
