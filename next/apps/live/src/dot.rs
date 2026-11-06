//! The agents, as small electrons.
//!
//! A dot lives as long as its agent, keyed by id, so it can glide: each frame it moves toward
//! its target by k = 1 − e^(−dt × 3.2), leaving a short trail of light. Its glow follows its
//! state: Working 0.8, Planning 0.55, Idle 0.2 and smaller, Wants to talk blinks, Stuck blinks
//! slower. A white core sits in each. Helpers circle it on tilted orbits, like electrons around
//! a nucleus. A crate it carries floats over it. With reduced motion nothing blinks, glides,
//! trails or circles.

use crate::draw::{phase, srgba, Frame, Kit, Pace, Shape, BLINKING, FAIL, IDLE, INK, MOVING, THINK, WAIT, WORK};
use crate::{Current, Dot, State, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::collections::HashMap;

/// One agent's dot. Its children draw it.
#[derive(Component)]
struct Agent {
    target: Vec2,
    look: Look,
    phase: f32,
    /// This dot's own glow colour, so its blink is its own.
    glow: Handle<ColorMaterial>,
}

/// What a dot looks like apart from where it stands. A change rebuilds its children.
#[derive(Clone, PartialEq)]
struct Look {
    r: f32,
    state: State,
    helpers: u32,
    selected: bool,
    hovered: bool,
    carry: Option<u32>,
}

/// A helper circling its agent, the `i`th of `n`.
#[derive(Component)]
struct Helper {
    i: u32,
    n: u32,
    r: f32,
}

/// A bit of trail left by a moving dot. It shrinks away.
#[derive(Component)]
struct Puff {
    born: f32,
    size: f32,
}

/// Most helpers drawn as electrons. A bigger swarm still reads as a swarm.
const MAX_HELPERS: u32 = 12;
const PUFF_LIFE: f32 = 0.45;

#[derive(Resource, Default)]
struct Dots(HashMap<String, Entity>);

const Z: f32 = 0.4;

pub(crate) fn plugin(app: &mut App) {
    app.init_resource::<Dots>()
        .add_systems(Update, (sync.run_if(resource_changed::<Current>), glide, fade_puffs, shine, circle).chain().in_set(Step::Draw));
}

fn colour(s: State) -> u32 {
    match s {
        State::Work => WORK,
        State::Think => THINK,
        State::Turn => WAIT,
        State::Idle => IDLE,
        State::Stuck => FAIL,
    }
}

/// The glow radius and alpha at time `t`, by state.
fn glow(look: &Look, phase: f32, t: f32, reduced: bool) -> (f32, f32) {
    let gr = look.r * 4.0;
    if reduced {
        return (if look.state == State::Idle { gr * 0.75 } else { gr }, if look.state == State::Idle { 0.2 } else { 0.7 });
    }
    match look.state {
        State::Work => (gr, 0.8),
        State::Think => (gr, 0.55),
        State::Turn => (gr * 1.15, 0.55 + 0.4 * (0.5 + 0.5 * (t * 4.5 + phase).sin())),
        State::Idle => (gr * 0.75, 0.2),
        State::Stuck => (gr, 0.35 + 0.45 * (0.5 + 0.5 * (t * 2.2 + phase).sin())),
    }
}

#[allow(clippy::too_many_arguments)]
fn sync(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut index: ResMut<Dots>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    current: Res<Current>,
    frame: Res<Frame>,
    time: Res<Time>,
    mut agents: Query<(&mut Agent, &mut Transform)>,
) {
    let frame = *frame;
    let reduced = current.0.reduced;
    let seen: std::collections::HashSet<&str> = current.0.dots.iter().map(|d| d.id.as_str()).collect();
    index.0.retain(|id, e| {
        if seen.contains(id.as_str()) {
            return true;
        }
        if let Ok((a, _)) = agents.get(*e) {
            mats.remove(&a.glow);
        }
        commands.entity(*e).despawn();
        false
    });
    for d in &current.0.dots {
        let carry = d.carry.as_deref().map(|c| crate::hex(Some(c)));
        let look = Look { r: d.r, state: d.state, helpers: d.helpers.min(MAX_HELPERS), selected: d.selected, hovered: d.hovered, carry };
        let target = Vec2::new(d.x, d.y);
        if let Some(&e) = index.0.get(&d.id) {
            if let Ok((mut a, mut tf)) = agents.get_mut(e) {
                a.target = target;
                if reduced {
                    tf.translation = frame.at(d.x, d.y, Z);
                }
                if a.look != look {
                    a.look = look.clone();
                    let (gr, al) = glow(&look, a.phase, time.elapsed_secs(), reduced);
                    if let Some(mut m) = mats.get_mut(&a.glow) {
                        m.color = srgba(colour(d.state), al);
                    }
                    let glow_mat = a.glow.clone();
                    commands.entity(e).despawn_related::<Children>();
                    build(&mut commands, e, &mut kit, &mut meshes, &mut mats, d, glow_mat, gr);
                }
                continue;
            }
        }
        let ph = phase(&d.id);
        let (gr, al) = glow(&look, ph, time.elapsed_secs(), reduced);
        let glow_mat = mats.add(ColorMaterial { color: srgba(colour(d.state), al), alpha_mode: AlphaMode2d::Blend, ..default() });
        let e = commands.spawn((Transform::from_translation(frame.at(d.x, d.y, Z)), Visibility::default(), Agent { target, look, phase: ph, glow: glow_mat.clone() })).id();
        build(&mut commands, e, &mut kit, &mut meshes, &mut mats, d, glow_mat, gr);
        index.0.insert(d.id.clone(), e);
    }
}

#[allow(clippy::too_many_arguments)]
fn build(commands: &mut Commands, e: Entity, kit: &mut Kit, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, d: &Dot, glow_mat: Handle<ColorMaterial>, gr: f32) {
    let col = colour(d.state);
    let glow = kit.shape(meshes, Shape::Glow);
    let circle = kit.shape(meshes, Shape::Circle);
    let mut parts: Vec<(Handle<Mesh>, Handle<ColorMaterial>, Transform)> = vec![
        // Glows sit under every core, so a neighbour's glow never covers a dot.
        (glow.clone(), glow_mat, Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(gr))),
        (circle.clone(), kit.paint(mats, col, 1.0), Transform::from_scale(Vec3::splat(d.r))),
    ];
    parts.push((circle.clone(), kit.paint(mats, 0xFFFFFF, 0.8), Transform::from_xyz(0.0, 0.0, 0.01).with_scale(Vec3::splat(d.r * 0.4))));
    if let Some(c) = d.carry.as_deref().map(|c| crate::hex(Some(c))) {
        let square = kit.shape(meshes, Shape::Square);
        let lift = d.r + 9.0;
        let tilt = Quat::from_rotation_z(std::f32::consts::FRAC_PI_4);
        parts.push((glow.clone(), kit.paint(mats, c, 0.6), Transform::from_xyz(0.0, lift, -0.05).with_scale(Vec3::splat(16.0))));
        parts.push((square, kit.paint(mats, c, 1.0), Transform::from_xyz(0.0, lift, 0.03).with_rotation(tilt).with_scale(Vec3::new(6.0, 6.0, 1.0))));
    }
    if d.selected || d.hovered {
        let rr = d.r + 5.0;
        let ring = kit.shape(meshes, Shape::Ring((1.5 / rr * 1000.0).round() as i32));
        parts.push((ring, kit.paint(mats, INK, if d.selected { 0.9 } else { 0.5 }), Transform::from_xyz(0.0, 0.0, 0.02).with_scale(Vec3::splat(rr + 0.75))));
    }
    commands.entity(e).with_children(|p| {
        for (mesh, mat, tf) in parts {
            p.spawn((Mesh2d(mesh), MeshMaterial2d(mat), tf));
        }
        let n = d.helpers.min(MAX_HELPERS);
        // Three orbit planes, like the shells drawn around an atom.
        let shells = kit.shape(meshes, Shape::Ellipse(crate::draw::tenth(d.r + 11.0), crate::draw::tenth((d.r + 11.0) * 0.36), 6));
        for s in 0..n.min(3) {
            p.spawn((Mesh2d(shells.clone()), MeshMaterial2d(kit.paint(mats, col, 0.22)), Transform::from_xyz(0.0, 0.0, -0.02).with_rotation(Quat::from_rotation_z(s as f32 * std::f32::consts::FRAC_PI_3))));
        }
        for i in 0..n {
            p.spawn((Transform::from_xyz(0.0, 0.0, 0.005), Visibility::default(), Helper { i, n, r: d.r })).with_children(|h| {
                h.spawn((Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(mats, col, 0.4)), Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(5.0))));
                h.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(mats, col, 0.85)), Transform::from_scale(Vec3::splat(1.4))));
            });
        }
    });
}

/// Each dot moves toward its target, leaving puffs of light. While any moves, frames come at
/// 33 ms.
#[allow(clippy::too_many_arguments)]
fn glide(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    time: Res<Time>,
    frame: Res<Frame>,
    current: Res<Current>,
    mut pace: ResMut<Pace>,
    mut agents: Query<(&Agent, &mut Transform)>,
) {
    let reduced = current.0.reduced;
    let k = if reduced { 1.0 } else { 1.0 - (-time.delta_secs() * 3.2).exp() };
    let glow = kit.shape(&mut meshes, Shape::Glow);
    for (a, mut tf) in &mut agents {
        let to = frame.at(a.target.x, a.target.y, Z);
        let d = to - tf.translation;
        if d.truncate().length() < 0.2 {
            tf.translation = to;
            continue;
        }
        let step = d * k;
        if !reduced && step.truncate().length() > 0.8 {
            let size = a.look.r * 3.2;
            let paint = kit.paint(&mut mats, colour(a.look.state), 0.5);
            commands.spawn((Mesh2d(glow.clone()), MeshMaterial2d(paint), Transform::from_translation(tf.translation.with_z(Z - 0.05)).with_scale(Vec3::splat(size)), Puff { born: time.elapsed_secs(), size }));
        }
        tf.translation += step;
        pace.ask(MOVING);
    }
}

fn fade_puffs(mut commands: Commands, time: Res<Time>, mut pace: ResMut<Pace>, mut puffs: Query<(Entity, &Puff, &mut Transform)>) {
    let now = time.elapsed_secs();
    for (e, p, mut tf) in &mut puffs {
        let u = (now - p.born) / PUFF_LIFE;
        if u >= 1.0 {
            commands.entity(e).despawn();
            continue;
        }
        pace.ask(MOVING);
        tf.scale = Vec3::splat(p.size * (1.0 - u) * (1.0 - u));
    }
}

/// Wants to talk and Stuck blink. Each dot keeps its own phase.
fn shine(time: Res<Time>, current: Res<Current>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>, agents: Query<&Agent>) {
    if current.0.reduced {
        return;
    }
    let t = time.elapsed_secs();
    for a in &agents {
        if !matches!(a.look.state, State::Turn | State::Stuck) {
            continue;
        }
        pace.ask(BLINKING);
        let (_, al) = glow(&a.look, a.phase, t, false);
        if let Some(mut m) = mats.get_mut(&a.glow) {
            m.color = crate::draw::fade(m.color, al);
        }
    }
}

/// Helpers circle on three tilted ellipses, 2.4 radians a second.
fn circle(time: Res<Time>, current: Res<Current>, mut pace: ResMut<Pace>, agents: Query<&Agent>, mut helpers: Query<(&Helper, &ChildOf, &mut Transform)>) {
    let reduced = current.0.reduced;
    let t = if reduced { 0.0 } else { time.elapsed_secs() };
    for (h, parent, mut tf) in &mut helpers {
        if !reduced {
            pace.ask(MOVING);
        }
        let ph = agents.get(parent.parent()).map(|a| a.phase).unwrap_or(0.0);
        let shell = h.i % 3;
        let per_shell = h.n.div_ceil(3).max(1);
        let an = t * (2.4 - 0.3 * shell as f32) + (h.i / 3) as f32 * std::f32::consts::TAU / per_shell as f32 + ph + shell as f32;
        let (rx, ry) = (h.r + 11.0, (h.r + 11.0) * 0.36);
        let p = Vec2::new(an.cos() * rx, an.sin() * ry);
        let tilt = shell as f32 * std::f32::consts::FRAC_PI_3;
        let (s, c) = tilt.sin_cos();
        tf.translation.x = p.x * c - p.y * s;
        tf.translation.y = p.x * s + p.y * c;
    }
}
