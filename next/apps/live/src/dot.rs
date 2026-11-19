//! The agents, as small electrons.
//!
//! A dot lives as long as its agent, keyed by id, so it can glide: each frame it moves toward
//! its target by k = 1 − e^(−dt × 3.2), leaving a short trail of light. Its glow follows its
//! state: Working 0.8, Planning 0.55, Idle 0.2 and smaller, Wants to talk blinks, Stuck blinks
//! slower. A white core sits in each. Helpers circle it on tilted orbits, like electrons around
//! a nucleus, each in its own state's colour. A crate it carries floats over it. With reduced
//! motion nothing blinks, glides, trails or circles.
//!
//! A working dot shows what it does, close around it: sparks fly off it while it makes
//! something, a light scans around it while it reads, a ring opens while it checks, and three
//! dots bob over it while it thinks or writes to someone. What its helpers report flies in along
//! the orbit to its core, and what it sends them flies out. Owner, 2026-11-19: "So I see dots
//! communicating, collaborating, doing things in the project."

use crate::draw::{ease, fade, phase, srgba, Frame, Kit, Pace, Shape, BLINKING, FAIL, IDLE, INK, MOVING, THINK, WAIT, WORK};
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
    /// The scene's `pings` and `calls` last seen. A rise sends sparks along the orbit.
    pings: u32,
    calls: u32,
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
    act: Act,
    crew: Vec<State>,
}

/// What a working dot is seen doing (live_scene.ts `act`).
#[derive(Clone, Copy, PartialEq)]
enum Act {
    None,
    Make,
    Look,
    Check,
    Say,
    Think,
}

fn act_of(word: Option<&str>) -> Act {
    match word {
        Some("make") => Act::Make,
        Some("look") => Act::Look,
        Some("check") => Act::Check,
        Some("say") => Act::Say,
        Some("think") => Act::Think,
        _ => Act::None,
    }
}

/// A helper circling its agent, the `i`th of `n`.
#[derive(Component)]
struct Helper {
    i: u32,
    n: u32,
    r: f32,
}

/// One part of a dot's act, the `i`th. `lift` is how far over the core the bobbing dots sit.
/// `paint` is its own colour when it fades alone.
#[derive(Component)]
struct Motion {
    act: Act,
    i: u32,
    r: f32,
    lift: f32,
    paint: Option<Handle<ColorMaterial>>,
}

/// A spark between a helper on its orbit and the core: in for a report, out for an order.
#[derive(Component)]
struct Ping {
    born: f32,
    i: u32,
    n: u32,
    r: f32,
    inward: bool,
}

const PING_LIFE: f32 = 0.55;
/// Most sparks one rise sends. A burst of ten steps still reads as busy, not as a blizzard.
const MAX_PINGS: u32 = 4;

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
        .add_systems(Update, (sync.run_if(resource_changed::<Current>), glide, fade_puffs, shine, circle, work, fly).chain().in_set(Step::Draw));
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
        let n = d.helpers.min(MAX_HELPERS);
        // With reduced motion a dot shows no act: every part of one moves.
        let act = if reduced { Act::None } else { act_of(d.act.as_deref()) };
        let crew = d.crew.iter().take(n as usize).copied().collect();
        let look = Look { r: d.r, state: d.state, helpers: n, selected: d.selected, hovered: d.hovered, carry, act, crew };
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
                    build(&mut commands, e, &mut kit, &mut meshes, &mut mats, d, &look, glow_mat, gr);
                }
                // What the helpers said since the last scene, and what it told them.
                let (ins, outs) = (d.pings.saturating_sub(a.pings), d.calls.saturating_sub(a.calls));
                (a.pings, a.calls) = (d.pings, d.calls);
                if !reduced && n > 0 && ins + outs > 0 {
                    let born = time.elapsed_secs();
                    let glow = kit.shape(&mut meshes, Shape::Glow);
                    let circle = kit.shape(&mut meshes, Shape::Circle);
                    let sends = (0..ins.min(MAX_PINGS)).map(|k| (true, (d.pings + k) % n)).chain((0..outs.min(MAX_PINGS)).map(|k| (false, k % n)));
                    for (inward, i) in sends.collect::<Vec<_>>() {
                        let hue = if inward { WORK } else { THINK };
                        commands.entity(e).with_children(|p| {
                            p.spawn((Transform::from_xyz(0.0, 0.0, 0.02), Visibility::default(), Ping { born: born + if inward { 0.0 } else { 0.08 * i as f32 }, i, n, r: d.r, inward }))
                                .with_children(|s| {
                                    s.spawn((Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, 0.7)), Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(6.0))));
                                    s.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(&mut mats, 0xFFFFFF, 0.95)), Transform::from_scale(Vec3::splat(1.2))));
                                });
                        });
                    }
                }
                continue;
            }
        }
        let ph = phase(&d.id);
        let (gr, al) = glow(&look, ph, time.elapsed_secs(), reduced);
        let glow_mat = mats.add(ColorMaterial { color: srgba(colour(d.state), al), alpha_mode: AlphaMode2d::Blend, ..default() });
        let e = commands.spawn((Transform::from_translation(frame.at(d.x, d.y, Z)), Visibility::default(), Agent { target, look: look.clone(), phase: ph, glow: glow_mat.clone(), pings: d.pings, calls: d.calls })).id();
        build(&mut commands, e, &mut kit, &mut meshes, &mut mats, d, &look, glow_mat, gr);
        index.0.insert(d.id.clone(), e);
    }
}

#[allow(clippy::too_many_arguments)]
fn build(commands: &mut Commands, e: Entity, kit: &mut Kit, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, d: &Dot, look: &Look, glow_mat: Handle<ColorMaterial>, gr: f32) {
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
            // A helper the scan sees has its own state: one waiting on the owner blinks amber
            // in a cyan swarm. Helpers inside a session take their agent's colour.
            let hue = look.crew.get(i as usize).map_or(col, |s| colour(*s));
            p.spawn((Transform::from_xyz(0.0, 0.0, 0.005), Visibility::default(), Helper { i, n, r: d.r })).with_children(|h| {
                h.spawn((Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(mats, hue, 0.4)), Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(5.0))));
                h.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(mats, hue, 0.85)), Transform::from_scale(Vec3::splat(1.4))));
            });
        }
        // The act's parts, each moved by `work`. The bobbing dots clear the orbits when there are any.
        let lift = d.r + if n > 0 { 15.0 } else { 8.0 };
        let ring = kit.shape(meshes, Shape::Ring(110));
        let mut part = |p: &mut ChildSpawnerCommands, i: u32, hex: u32, alpha: f32, size: f32, own: bool, mesh: &Handle<Mesh>| {
            let paint = if own { mats.add(ColorMaterial { color: srgba(hex, alpha), alpha_mode: AlphaMode2d::Blend, ..default() }) } else { kit.paint(mats, hex, alpha) };
            p.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(paint.clone()), Transform::from_xyz(0.0, 0.0, 0.015).with_scale(Vec3::splat(size)), Motion { act: look.act, i, r: d.r, lift, paint: own.then_some(paint) }));
        };
        match look.act {
            Act::Make => (0..4).for_each(|i| part(p, i, WORK, 0.95, 1.3, false, &circle)),
            // A bright head with a fading tail, like a radar's sweep.
            Act::Look => (0..4).for_each(|i| part(p, i, WORK, 0.9 - 0.2 * i as f32, 1.3 - 0.18 * i as f32, false, &circle)),
            Act::Check => part(p, 0, WORK, 0.5, d.r + 2.0, true, &ring),
            Act::Say | Act::Think => (0..3).for_each(|i| part(p, i, if look.act == Act::Say { WORK } else { THINK }, 0.95, 1.15, false, &circle)),
            Act::None => {}
        }
    });
}

/// Where helper `i` of `n` is on its orbit at time `t`, around its agent's core.
fn orbit(i: u32, n: u32, r: f32, phase: f32, t: f32) -> Vec2 {
    let shell = i % 3;
    let per_shell = n.div_ceil(3).max(1);
    let an = t * (2.4 - 0.3 * shell as f32) + (i / 3) as f32 * std::f32::consts::TAU / per_shell as f32 + phase + shell as f32;
    let (rx, ry) = (r + 11.0, (r + 11.0) * 0.36);
    let p = Vec2::new(an.cos() * rx, an.sin() * ry);
    let tilt = shell as f32 * std::f32::consts::FRAC_PI_3;
    let (s, c) = tilt.sin_cos();
    Vec2::new(p.x * c - p.y * s, p.x * s + p.y * c)
}

/// A number in 0..1 that looks random but is the same for the same `x`.
fn hash(x: f32) -> f32 {
    (x.sin() * 43_758.547).fract().abs()
}

/// Moves each dot's act. Sparks leave at their own angle over the dot and shrink as they fly. The
/// scan turns about once a second and a half. The ring opens every 1.2 s. The three dots bob in turn.
fn work(time: Res<Time>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>, agents: Query<&Agent>, mut parts: Query<(&Motion, &ChildOf, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (m, parent, mut tf) in &mut parts {
        pace.ask(MOVING);
        let ph = agents.get(parent.parent()).map(|a| a.phase).unwrap_or(0.0);
        let i = m.i as f32;
        match m.act {
            Act::Make => {
                let k = t / 0.55 + i / 4.0 + ph;
                let u = k.fract();
                let a = 0.35 + 2.45 * hash(k.floor() * 7.13 + i * 1.7 + ph);
                let at = Vec2::from_angle(a) * (m.r + 2.0 + 10.0 * u);
                tf.translation = at.extend(0.015);
                tf.scale = Vec3::splat(1.3 * (1.0 - u));
            }
            Act::Look => {
                let at = Vec2::from_angle(t * 4.2 + ph - i * 0.32) * (m.r + 5.5);
                tf.translation = at.extend(0.015);
            }
            Act::Check => {
                let u = (t / 1.2 + ph).fract();
                tf.scale = Vec3::splat(m.r + 2.0 + 12.0 * u);
                if let Some(mut mat) = m.paint.as_ref().and_then(|p| mats.get_mut(p)) {
                    mat.color = fade(mat.color, 0.55 * (1.0 - u));
                }
            }
            Act::Say | Act::Think => {
                let bob = (t * 6.0 - i * 0.9 + ph).sin().max(0.0);
                tf.translation = Vec3::new((i - 1.0) * 3.6, m.lift + 1.8 * bob, 0.015);
            }
            Act::None => {}
        }
    }
}

/// Each spark rides between a helper and the core, following the helper as it circles.
fn fly(mut commands: Commands, time: Res<Time>, mut pace: ResMut<Pace>, agents: Query<&Agent>, mut pings: Query<(Entity, &Ping, &ChildOf, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (e, p, parent, mut tf) in &mut pings {
        let u = (t - p.born) / PING_LIFE;
        if u >= 1.0 {
            commands.entity(e).despawn();
            continue;
        }
        pace.ask(MOVING);
        let u = u.max(0.0);
        let ph = agents.get(parent.parent()).map(|a| a.phase).unwrap_or(0.0);
        let helper = orbit(p.i, p.n, p.r, ph, t);
        let k = ease(u);
        let at = if p.inward { helper.lerp(Vec2::ZERO, k) } else { Vec2::ZERO.lerp(helper, k) };
        tf.translation = at.extend(0.02);
        // It swells on the way and is gone as it lands.
        tf.scale = Vec3::splat(0.6 + 0.8 * (1.0 - (2.0 * u - 1.0).abs()));
    }
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
        let p = orbit(h.i, h.n, h.r, ph, t);
        tf.translation.x = p.x;
        tf.translation.y = p.y;
    }
}
