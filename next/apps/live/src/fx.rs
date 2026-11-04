//! The playbook's one-shot effects and the flights along card threads. Copied from the concept
//! page: `burst` line 695, flights and rings lines 983 to 999, the step pulse line 1018.
//! Each effect owns its colour so it can fade alone, and despawns with it when it ends.
//! With reduced motion no effect plays.

use crate::draw::{bezier, ease, line, rounded_edge, srgba, Dice, Frame, Kit, Pace, Shape, DONE, FAIL, INK, MOVING, WAIT, WORK};
use crate::{Current, Dir, FxKind, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;

#[derive(Clone, Copy)]
enum Kind {
    /// A light along a card's thread: in to the ring, or out to the room.
    Flight { p: [Vec2; 4], out: bool },
    /// A ring of light opening around a room box.
    Shipped { x: f32, y: f32, w: f32, h: f32 },
    Spark { pos: Vec2, vel: Vec2 },
    Flicker { at: Vec2, r: f32 },
    BeamLine { a: Vec2, b: Vec2 },
    BeamHead { a: Vec2, b: Vec2 },
    Pulse { at: Vec2, r: f32 },
    Clash { a: Vec2, b: Vec2 },
}

#[derive(Component)]
struct Effect {
    kind: Kind,
    began: f32,
    /// Seconds it lasts.
    len: f32,
    paint: Handle<ColorMaterial>,
    /// A mesh this effect reshapes as it plays.
    own_mesh: Option<Handle<Mesh>>,
}

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, (start.run_if(resource_changed::<Current>), play).chain().in_set(Step::Draw));
}

#[allow(clippy::too_many_arguments)]
fn start(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut dice: ResMut<Dice>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    time: Res<Time>,
    current: Res<Current>,
) {
    if current.0.reduced {
        return;
    }
    let now = time.elapsed_secs();
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let square = kit.shape(&mut meshes, Shape::Square);
    let mut spawn = |mats: &mut Assets<ColorMaterial>, kind: Kind, len: f32, hex: u32, mesh: Handle<Mesh>, own_mesh: Option<Handle<Mesh>>| {
        let paint = mats.add(ColorMaterial { color: srgba(hex, 0.0), alpha_mode: AlphaMode2d::Blend, ..default() });
        commands.spawn((Mesh2d(mesh), MeshMaterial2d(paint.clone()), Transform::from_scale(Vec3::ZERO), Effect { kind, began: now, len, paint, own_mesh }));
    };
    for f in &current.0.flights {
        let p = f.p.map(|q| Vec2::new(q[0], q[1]));
        let out = f.dir == Dir::Out;
        spawn(&mut mats, Kind::Flight { p, out }, 1.1, if out { INK } else { WAIT }, glow.clone(), None);
    }
    for fx in current.0.fx.iter().copied() {
        let at = Vec2::new(fx.x, fx.y);
        let to = Vec2::new(fx.x2, fx.y2);
        match fx.kind {
            FxKind::Pulse => spawn(&mut mats, Kind::Pulse { at, r: fx.r }, 0.9, WORK, glow.clone(), None),
            FxKind::Ship => spawn(&mut mats, Kind::Pulse { at, r: fx.r }, 0.9, DONE, glow.clone(), None),
            FxKind::Beam => {
                spawn(&mut mats, Kind::BeamLine { a: at, b: to }, 2.4, INK, square.clone(), None);
                spawn(&mut mats, Kind::BeamHead { a: at, b: to }, 2.4, INK, glow.clone(), None);
            }
            FxKind::Done | FxKind::Cut => {
                let hex = if fx.kind == FxKind::Done { DONE } else { FAIL };
                for _ in 0..14 {
                    let an = dice.range(0.0, std::f32::consts::TAU);
                    let sp = dice.range(30.0, 90.0);
                    let life = dice.range(0.6, 1.1);
                    spawn(&mut mats, Kind::Spark { pos: at, vel: Vec2::new(an.cos(), an.sin()) * sp }, life, hex, glow.clone(), None);
                }
                if fx.kind == FxKind::Cut {
                    spawn(&mut mats, Kind::Flicker { at, r: fx.r }, 1.0, FAIL, glow.clone(), None);
                }
            }
            FxKind::Shipped => {
                let mesh = meshes.add(rounded_edge(1.0, 1.0, 0.0, 1.0));
                spawn(&mut mats, Kind::Shipped { x: fx.x, y: fx.y, w: fx.x2 - fx.x, h: fx.y2 - fx.y }, 1.6, DONE, mesh.clone(), Some(mesh));
            }
            FxKind::Clash => spawn(&mut mats, Kind::Clash { a: at, b: to }, 1.5, FAIL, square.clone(), None),
            // A new card already flies along its thread: the flight is its effect.
            FxKind::Card | FxKind::Unknown => {}
        }
    }
}

fn play(
    mut commands: Commands,
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
    for (e, mut fx, mut tf) in &mut effects {
        pace.ask(MOVING);
        let age = now - fx.began;
        let u = (age / fx.len).clamp(0.0, 1.0);
        if u >= 1.0 {
            commands.entity(e).despawn();
            mats.remove(&fx.paint);
            if let Some(m) = &fx.own_mesh {
                meshes.remove(m);
            }
            continue;
        }
        let glow_at = |p: Vec2, r: f32, z: f32| Transform::from_translation(frame.at(p.x, p.y, z)).with_scale(Vec3::splat(r));
        let (alpha, t) = match fx.kind {
            Kind::Flight { p, out } => {
                let k = ease(u);
                (0.95 * (1.0 - u * 0.4), glow_at(bezier(p, if out { 1.0 - k } else { k }), 14.0, 0.7))
            }
            Kind::Shipped { x, y, w, h } => {
                let s = 4.0 + u * 16.0;
                if let Some(mut m) = fx.own_mesh.as_ref().and_then(|m| meshes.get_mut(m)) {
                    *m = rounded_edge(w + s * 2.0 + 2.0, h + s * 2.0 + 2.0, 10.0 + s, 2.0);
                }
                (0.7 * (1.0 - u), Transform::from_translation(frame.at(x + w / 2.0, y + h / 2.0, 0.7)))
            }
            Kind::Spark { pos, vel } => {
                // The concept damps by 0.94 a frame at 60 frames a second.
                let next = pos + vel * dt;
                fx.kind = Kind::Spark { pos: next, vel: vel * 0.94f32.powf(dt * 60.0) };
                (1.0 - u, glow_at(next, 7.0, 0.7))
            }
            Kind::Flicker { at, r } => {
                let on = if (u * 9.0) as u32 % 2 == 0 { 1.0 } else { 0.25 };
                (0.9 * (1.0 - u) * on, glow_at(at, r * 4.0, 0.7))
            }
            Kind::BeamLine { a, b } => (0.55 * (1.0 - u), line(frame, a, b, 0.68, 1.6)),
            Kind::BeamHead { a, b } => (1.0 - u, glow_at(a.lerp(b, (age / 0.8).min(1.0)), 18.0, 0.69)),
            Kind::Pulse { at, r } => (0.55 * (1.0 - u), glow_at(at, r * (3.0 + 5.0 * u), 0.7)),
            Kind::Clash { a, b } => (0.8 * (1.0 - u), line(frame, a, b, 0.68, 1.6)),
        };
        *tf = t;
        if let Some(mut m) = mats.get_mut(&fx.paint) {
            m.color = crate::draw::fade(m.color, alpha);
        }
    }
}
