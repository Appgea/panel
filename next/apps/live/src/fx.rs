//! Effects: the moves animation scripts and the playbook are made of. Each `Fx` in a scene
//! starts after its `delay`, plays for its `ms`, and despawns. Each effect owns its colour so it
//! can fade alone. With reduced motion no effect plays.
//!
//! - `orb`: a glowing ball from x, y to x2, y2, easing in and out, shedding a trail.
//! - `beam`: a line of light from x, y to x2, y2 with a head that runs along it, then fades.
//! - `pulse`: a soft glow that swells to `size` and fades.
//! - `ring`: a thin ring that grows to `size` and fades.
//! - `burst`: `count` sparks fly out and slow down.
//! - `sweep`: a radar arm of length `size` turning around the point, two turns a second.
//! - `orbit`: `count` electrons circling the point at radius `size`.

use crate::draw::{ease, line, srgba, Dice, Frame, Kit, Pace, Shape, MOVING};
use crate::{Current, FxKind, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;

#[derive(Clone, Copy)]
enum Kind {
    Orb { a: Vec2, b: Vec2, size: f32 },
    Trail { at: Vec2, size: f32 },
    BeamLine { a: Vec2, b: Vec2 },
    BeamHead { a: Vec2, b: Vec2 },
    Pulse { at: Vec2, size: f32 },
    Ring { at: Vec2, size: f32 },
    Spark { pos: Vec2, vel: Vec2 },
    SweepArm { at: Vec2, size: f32 },
    SweepTip { at: Vec2, size: f32 },
    Electron { at: Vec2, size: f32, i: u32, n: u32 },
}

#[derive(Component)]
struct Effect {
    kind: Kind,
    began: f32,
    /// Seconds it lasts.
    len: f32,
    hex: u32,
    paint: Handle<ColorMaterial>,
}

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, (start.run_if(resource_changed::<Current>), play).chain().in_set(Step::Draw));
}

/// What to spawn: a kind, its length, colour, mesh and start time.
struct New {
    kind: Kind,
    len: f32,
    hex: u32,
    mesh: Handle<Mesh>,
    began: f32,
}

fn spawn(commands: &mut Commands, mats: &mut Assets<ColorMaterial>, n: New) {
    let paint = mats.add(ColorMaterial { color: srgba(n.hex, 0.0), alpha_mode: AlphaMode2d::Blend, ..default() });
    commands.spawn((Mesh2d(n.mesh), MeshMaterial2d(paint.clone()), Transform::from_scale(Vec3::ZERO), Effect { kind: n.kind, began: n.began, len: n.len, hex: n.hex, paint }));
}

fn start(mut commands: Commands, mut kit: ResMut<Kit>, mut dice: ResMut<Dice>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>, time: Res<Time>, current: Res<Current>) {
    if current.0.reduced {
        return;
    }
    let now = time.elapsed_secs();
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let square = kit.shape(&mut meshes, Shape::Square);
    let ring = kit.shape(&mut meshes, Shape::Ring(30));
    for fx in &current.0.fx {
        let at = Vec2::new(fx.x, fx.y);
        let to = Vec2::new(fx.x2.unwrap_or(fx.x), fx.y2.unwrap_or(fx.y));
        let hex = crate::hex(fx.color.as_deref());
        let began = now + fx.delay.unwrap_or(0.0).max(0.0) / 1000.0;
        let len = |default_ms: f32| (fx.ms.unwrap_or(default_ms).clamp(100.0, 8000.0)) / 1000.0;
        let mut add = |kind: Kind, len: f32, mesh: &Handle<Mesh>| spawn(&mut commands, &mut mats, New { kind, len, hex, mesh: mesh.clone(), began });
        match fx.kind {
            FxKind::Orb => add(Kind::Orb { a: at, b: to, size: fx.size.unwrap_or(6.0) }, len(900.0), &glow),
            FxKind::Beam => {
                add(Kind::BeamLine { a: at, b: to }, len(1200.0), &square);
                add(Kind::BeamHead { a: at, b: to }, len(1200.0), &glow);
            }
            FxKind::Pulse => add(Kind::Pulse { at, size: fx.size.unwrap_or(30.0) }, len(900.0), &glow),
            FxKind::Ring => add(Kind::Ring { at, size: fx.size.unwrap_or(60.0) }, len(1200.0), &ring),
            FxKind::Burst => {
                for _ in 0..fx.count.unwrap_or(14).min(40) {
                    let an = dice.range(0.0, std::f32::consts::TAU);
                    let sp = dice.range(30.0, 90.0) * fx.size.unwrap_or(30.0) / 30.0;
                    add(Kind::Spark { pos: at, vel: Vec2::new(an.cos(), an.sin()) * sp }, dice.range(0.6, 1.1), &glow);
                }
            }
            FxKind::Sweep => {
                let size = fx.size.unwrap_or(70.0);
                add(Kind::SweepArm { at, size }, len(2000.0), &square);
                add(Kind::SweepTip { at, size }, len(2000.0), &glow);
            }
            FxKind::Orbit => {
                let n = fx.count.unwrap_or(3).clamp(1, 12);
                for i in 0..n {
                    add(Kind::Electron { at, size: fx.size.unwrap_or(18.0), i, n }, len(2000.0), &glow);
                }
            }
            FxKind::Unknown => {}
        }
    }
}

/// Fades in over the first tenth and out over the last third.
fn envelope(u: f32) -> f32 {
    (u / 0.1).min(1.0) * ((1.0 - u) / 0.33).min(1.0)
}

#[allow(clippy::too_many_arguments)]
fn play(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    time: Res<Time>,
    frame: Res<Frame>,
    mut pace: ResMut<Pace>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    mut effects: Query<(Entity, &mut Effect, &mut Transform)>,
) {
    let frame = *frame;
    let now = time.elapsed_secs();
    let dt = time.delta_secs();
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let mut trails: Vec<New> = Vec::new();
    for (e, mut fx, mut tf) in &mut effects {
        pace.ask(MOVING);
        let age = now - fx.began;
        if age < 0.0 {
            continue;
        }
        let u = (age / fx.len).clamp(0.0, 1.0);
        if u >= 1.0 {
            commands.entity(e).despawn();
            mats.remove(&fx.paint);
            continue;
        }
        let glow_at = |p: Vec2, r: f32, z: f32| Transform::from_translation(frame.at(p.x, p.y, z)).with_scale(Vec3::splat(r));
        let (alpha, t) = match fx.kind {
            Kind::Orb { a, b, size } => {
                let p = a.lerp(b, ease(u));
                trails.push(New { kind: Kind::Trail { at: p, size: size * 2.6 }, len: 0.5, hex: fx.hex, mesh: glow.clone(), began: now });
                (0.95 * (u / 0.08).min(1.0), glow_at(p, size * 3.2, 0.72))
            }
            Kind::Trail { at, size } => (0.45 * (1.0 - u), glow_at(at, size * (1.0 - u), 0.71)),
            Kind::BeamLine { a, b } => (0.6 * envelope(u), line(frame, a, b, 0.68, 1.6)),
            Kind::BeamHead { a, b } => (envelope(u), glow_at(a.lerp(b, ease((u / 0.45).min(1.0))), 18.0, 0.69)),
            Kind::Pulse { at, size } => (0.6 * (1.0 - u), glow_at(at, size * (0.5 + u), 0.7)),
            Kind::Ring { at, size } => (0.8 * (1.0 - u), glow_at(at, size * (0.15 + 0.85 * ease(u)), 0.7)),
            Kind::Spark { pos, vel } => {
                // Damped by 0.94 a frame at 60 frames a second.
                let next = pos + vel * dt;
                fx.kind = Kind::Spark { pos: next, vel: vel * 0.94f32.powf(dt * 60.0) };
                (1.0 - u, glow_at(next, 7.0, 0.7))
            }
            Kind::SweepArm { at, size } => {
                let an = age * std::f32::consts::TAU * 2.0;
                let tip = at + Vec2::new(an.cos(), an.sin()) * size;
                (0.55 * envelope(u), line(frame, at, tip, 0.69, 1.4))
            }
            Kind::SweepTip { at, size } => {
                let an = age * std::f32::consts::TAU * 2.0;
                (0.9 * envelope(u), glow_at(at + Vec2::new(an.cos(), an.sin()) * size, 14.0, 0.7))
            }
            Kind::Electron { at, size, i, n } => {
                let an = age * 3.2 + i as f32 * std::f32::consts::TAU / n as f32;
                let p = at + Vec2::new(an.cos() * size, an.sin() * size * 0.42);
                (envelope(u), glow_at(p, 8.0, 0.72))
            }
        };
        *tf = t;
        if let Some(mut m) = mats.get_mut(&fx.paint) {
            m.color = crate::draw::fade(m.color, alpha);
        }
    }
    for n in trails {
        spawn(&mut commands, &mut mats, n);
    }
}
