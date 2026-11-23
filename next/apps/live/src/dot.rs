use crate::draw::{ease, fade, lit_pair, parts, phase, srgba, Frame, Kit, Pace, Shape, BLINKING, FAIL, HULL, IDLE, INK, MOVING, THINK, WAIT, WORK};
use crate::{Current, Dot, State, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::collections::HashMap;
use std::f32::consts::{PI, TAU};

#[derive(Component)]
struct Agent {
    target: Vec2,
    look: Look,
    phase: f32,
    glow: Handle<ColorMaterial>,
    pings: u32,
    calls: u32,
    hull: Entity,
    heading: f32,
}

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
    ship: Ship,
    tint: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Ship {
    Flag,
    Cruiser,
    Builder,
    Scout,
    Drone,
}

fn ship_of(word: Option<&str>) -> Ship {
    match word {
        Some("flag") => Ship::Flag,
        Some("builder") => Ship::Builder,
        Some("scout") => Ship::Scout,
        Some("drone") => Ship::Drone,
        _ => Ship::Cruiser,
    }
}

type Poly = (Vec<(f32, f32)>, f32);

impl Ship {
    fn names(self) -> (&'static str, &'static str) {
        match self {
            Ship::Flag => ("flag-hull", "flag-trim"),
            Ship::Cruiser => ("cruiser-hull", "cruiser-trim"),
            Ship::Builder => ("builder-hull", "builder-trim"),
            Ship::Scout => ("scout-hull", "scout-trim"),
            Ship::Drone => ("drone-hull", "drone-trim"),
        }
    }

    fn tail(self) -> f32 {
        match self {
            Ship::Flag | Ship::Builder => -10.5,
            Ship::Cruiser => -8.5,
            Ship::Scout => -3.6,
            Ship::Drone => -4.6,
        }
    }

    fn reach(self) -> f32 {
        match self {
            Ship::Flag => 17.0,
            Ship::Cruiser | Ship::Builder => 14.0,
            Ship::Scout => 12.0,
            Ship::Drone => 9.0,
        }
    }

    fn hull(self) -> Mesh {
        let glass = 0.1;
        let mut p: Vec<Poly> = Vec::new();
        match self {
            Ship::Flag => {
                p.extend(lit_pair(&[(4.5, 3.6), (2.5, 7.6), (-9.0, 8.2), (-10.5, 6.0), (-7.0, 4.2)], 0.74));
                p.extend(lit_pair(&[(14.5, 0.0), (8.0, 3.3), (-7.0, 4.3), (-10.5, 2.6), (-10.5, 0.0)], 1.0));
                p.push((vec![(4.5, 0.0), (1.5, 2.0), (-4.0, 2.0), (-5.5, 0.0), (-4.0, -2.0), (1.5, -2.0)], glass));
            }
            Ship::Cruiser => {
                p.extend(lit_pair(&[(1.5, 2.7), (-7.0, 8.2), (-9.8, 8.2), (-6.0, 3.1)], 0.76));
                p.extend(lit_pair(&[(11.5, 0.0), (5.0, 2.8), (-6.0, 3.2), (-8.5, 1.7), (-8.5, 0.0)], 1.0));
                p.push((vec![(7.0, 0.0), (4.2, 1.35), (1.4, 0.0), (4.2, -1.35)], glass));
            }
            Ship::Builder => {
                p.extend(lit_pair(&[(-8.0, 4.3), (-10.5, 3.7), (-10.5, 1.2), (-8.0, 0.8)], 0.5));
                p.extend(lit_pair(&[(3.5, 5.2), (-8.0, 5.2), (-8.0, 0.0), (3.5, 0.0)], 0.62));
                p.extend(lit_pair(&[(10.0, 0.0), (8.2, 3.1), (3.5, 3.9), (3.5, 0.0)], 1.0));
                p.push((vec![(8.4, 0.0), (7.0, 1.6), (5.0, 1.6), (5.0, -1.6), (7.0, -1.6)], glass));
            }
            Ship::Scout => {
                p.extend(lit_pair(&[(10.5, 0.0), (-5.8, 4.3), (-3.2, 0.0)], 1.0));
                p.push((vec![(4.6, 0.0), (1.4, 1.1), (-0.4, 0.0), (1.4, -1.1)], glass));
            }
            Ship::Drone => {
                p.extend(lit_pair(&[(4.8, 0.0), (2.4, 4.2), (-2.4, 4.2), (-4.8, 0.0)], 0.92));
            }
        }
        parts(&p)
    }

    fn trim(self) -> Mesh {
        let mut p: Vec<Poly> = Vec::new();
        match self {
            Ship::Flag => {
                p.extend(lit_pair(&[(2.3, 6.3), (2.5, 7.6), (-9.0, 8.2), (-9.7, 7.1)], 1.0));
                p.push((vec![(14.5, 0.0), (10.6, 1.9), (9.4, 0.0), (10.6, -1.9)], 1.0));
            }
            Ship::Cruiser => {
                p.extend(lit_pair(&[(-5.4, 6.3), (-7.0, 8.2), (-9.8, 8.2), (-8.0, 5.6)], 1.0));
                p.push((vec![(0.2, 0.8), (-7.6, 1.0), (-7.6, -1.0), (0.2, -0.8)], 0.9));
            }
            Ship::Builder => {
                p.extend(lit_pair(&[(2.2, 3.9), (-1.9, 3.9), (-1.9, 0.0), (2.2, 0.0)], 1.0));
                p.extend(lit_pair(&[(-2.9, 3.9), (-6.9, 3.9), (-6.9, 0.0), (-2.9, 0.0)], 0.86));
            }
            Ship::Scout => {
                p.extend(lit_pair(&[(-3.2, 0.0), (-5.8, 4.3), (-8.0, 4.3), (-5.4, 0.0)], 1.0));
            }
            Ship::Drone => {
                p.push((vec![(2.2, 0.0), (0.0, 2.2), (-2.2, 0.0), (0.0, -2.2)], 1.0));
            }
        }
        parts(&p)
    }
}

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

#[derive(Component)]
struct Hull;

#[derive(Component)]
struct Flame {
    tail: f32,
}

#[derive(Component)]
struct Helper {
    i: u32,
    n: u32,
    r: f32,
}

#[derive(Component)]
struct Motion {
    act: Act,
    i: u32,
    r: f32,
    lift: f32,
    paint: Option<Handle<ColorMaterial>>,
}

#[derive(Component)]
struct Ping {
    born: f32,
    i: u32,
    n: u32,
    r: f32,
    inward: bool,
}

const PING_LIFE: f32 = 0.55;
const MAX_PINGS: u32 = 4;

#[derive(Component)]
struct Puff {
    born: f32,
    size: f32,
}

const MAX_HELPERS: u32 = 12;
const PUFF_LIFE: f32 = 0.5;
const SIZE: f32 = 1.2 / 3.8;

#[derive(Resource, Default)]
struct Dots(HashMap<String, Entity>);

const Z: f32 = 0.4;

pub(crate) fn plugin(app: &mut App) {
    app.init_resource::<Dots>()
        .add_systems(Update, (sync.run_if(resource_changed::<Current>), glide, fade_puffs, shine, circle, work, burn, fly).chain().in_set(Step::Draw));
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

fn glow(look: &Look, phase: f32, t: f32, reduced: bool) -> (f32, f32) {
    let gr = look.ship.reach() * size(look) * 1.9;
    if reduced {
        return (if look.state == State::Idle { gr * 0.75 } else { gr }, if look.state == State::Idle { 0.15 } else { 0.6 });
    }
    match look.state {
        State::Work => (gr, 0.62),
        State::Think => (gr, 0.48),
        State::Turn => (gr * 1.15, 0.5 + 0.45 * (0.5 + 0.5 * (t * 4.5 + phase).sin())),
        State::Idle => (gr * 0.75, 0.12),
        State::Stuck => (gr, 0.35 + 0.5 * (0.5 + 0.5 * (t * 2.2 + phase).sin())),
    }
}

fn look_of(d: &Dot, reduced: bool) -> Look {
    let n = d.helpers.min(MAX_HELPERS);
    Look {
        r: d.r,
        state: d.state,
        helpers: n,
        selected: d.selected,
        hovered: d.hovered,
        carry: d.carry.as_deref().map(|c| crate::hex(Some(c))),
        act: if reduced { Act::None } else { act_of(d.act.as_deref()) },
        crew: d.crew.iter().take(n as usize).copied().collect(),
        ship: ship_of(d.ship.as_deref()),
        tint: d.tint.as_deref().map(|c| crate::hex(Some(c))).unwrap_or(INK),
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
    let gone: Vec<(String, Entity)> = index.0.iter().filter(|(id, _)| !seen.contains(id.as_str())).map(|(id, e)| (id.clone(), *e)).collect();
    for (id, e) in gone {
        index.0.remove(&id);
        if let Ok((a, _)) = agents.get(e) {
            mats.remove(&a.glow);
        }
        commands.entity(e).despawn();
    }
    for d in &current.0.dots {
        let look = look_of(d, reduced);
        let n = look.helpers;
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
                    a.hull = build(&mut commands, e, &mut kit, &mut meshes, &mut mats, &look, glow_mat, gr);
                }
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
                            p.spawn((Transform::from_xyz(0.0, 0.0, 0.02), Visibility::default(), Ping { born: born + if inward { 0.0 } else { 0.08 * i as f32 }, i, n, r: orbit_r(&look), inward }))
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
        let e = commands.spawn((Transform::from_translation(frame.at(d.x, d.y, Z)), Visibility::default())).id();
        let hull = build(&mut commands, e, &mut kit, &mut meshes, &mut mats, &look, glow_mat.clone(), gr);
        commands.entity(e).insert(Agent { target, look, phase: ph, glow: glow_mat, pings: d.pings, calls: d.calls, hull, heading: 0.0 });
        index.0.insert(d.id.clone(), e);
    }
}

fn orbit_r(look: &Look) -> f32 {
    look.ship.reach() * size(look) - 9.0
}

fn size(look: &Look) -> f32 {
    look.r * SIZE * match look.ship {
        Ship::Drone => 1.5,
        Ship::Scout | Ship::Builder => 1.2,
        Ship::Flag | Ship::Cruiser => 1.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn build(commands: &mut Commands, e: Entity, kit: &mut Kit, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, look: &Look, glow_mat: Handle<ColorMaterial>, gr: f32) -> Entity {
    let col = colour(look.state);
    let glow = kit.shape(meshes, Shape::Glow);
    let circle = kit.shape(meshes, Shape::Circle);
    let scale = size(look);
    let reach = look.ship.reach() * scale;
    let (hull_name, trim_name) = look.ship.names();
    let ship = look.ship;
    let hull_mesh = kit.named(meshes, hull_name, || ship.hull());
    let trim_mesh = kit.named(meshes, trim_name, || ship.trim());
    let idle = look.state == State::Idle;
    let hull_paint = kit.paint(mats, HULL, if idle { 0.5 } else { 1.0 });
    let trim_paint = kit.paint(mats, look.tint, if idle { 0.55 } else { 1.0 });
    let lit = matches!(look.state, State::Work | State::Think);
    let flame = kit.named(meshes, "flame", || parts(&[(vec![(0.0, 1.7), (-6.5, 0.0), (0.0, -1.7)], 1.0)]));
    let flame_paint = kit.paint(mats, col, 0.95);
    let core_paint = kit.paint(mats, 0xFFFFFF, 0.9);
    let mut hull = Entity::PLACEHOLDER;
    let mut parts_list: Vec<(Handle<Mesh>, Handle<ColorMaterial>, Transform)> = vec![(glow.clone(), glow_mat, Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(gr)))];
    if let Some(c) = look.carry {
        let square = kit.shape(meshes, Shape::Square);
        let lift = reach * 0.6 + 6.0;
        let tilt = Quat::from_rotation_z(std::f32::consts::FRAC_PI_4);
        parts_list.push((glow.clone(), kit.paint(mats, c, 0.6), Transform::from_xyz(0.0, lift, -0.05).with_scale(Vec3::splat(16.0))));
        parts_list.push((square, kit.paint(mats, c, 1.0), Transform::from_xyz(0.0, lift, 0.03).with_rotation(tilt).with_scale(Vec3::new(6.0, 6.0, 1.0))));
    }
    if look.selected || look.hovered {
        let rr = reach + 5.0;
        let ring = kit.shape(meshes, Shape::Ring((1.5 / rr * 1000.0).round() as i32));
        parts_list.push((ring, kit.paint(mats, INK, if look.selected { 0.9 } else { 0.5 }), Transform::from_xyz(0.0, 0.0, 0.02).with_scale(Vec3::splat(rr + 0.75))));
    }
    let orbit = orbit_r(look);
    commands.entity(e).with_children(|p| {
        hull = p
            .spawn((Hull, Transform::from_scale(Vec3::splat(scale)), Visibility::default()))
            .with_children(|h| {
                h.spawn((Mesh2d(hull_mesh), MeshMaterial2d(hull_paint), Transform::from_xyz(0.0, 0.0, 0.0)));
                h.spawn((Mesh2d(trim_mesh), MeshMaterial2d(trim_paint), Transform::from_xyz(0.0, 0.0, 0.004)));
                if lit {
                    h.spawn((Mesh2d(flame.clone()), MeshMaterial2d(flame_paint), Transform::from_xyz(ship.tail(), 0.0, -0.004), Flame { tail: ship.tail() }));
                    h.spawn((Mesh2d(flame), MeshMaterial2d(core_paint), Transform::from_xyz(ship.tail(), 0.0, -0.002).with_scale(Vec3::new(0.45, 0.5, 1.0))));
                }
            })
            .id();
        for (mesh, mat, tf) in parts_list {
            p.spawn((Mesh2d(mesh), MeshMaterial2d(mat), tf));
        }
        let n = look.helpers.min(MAX_HELPERS);
        let shells = kit.shape(meshes, Shape::Ellipse(crate::draw::tenth(orbit + 11.0), crate::draw::tenth((orbit + 11.0) * 0.36), 6));
        for s in 0..n.min(3) {
            p.spawn((Mesh2d(shells.clone()), MeshMaterial2d(kit.paint(mats, col, 0.2)), Transform::from_xyz(0.0, 0.0, -0.02).with_rotation(Quat::from_rotation_z(s as f32 * std::f32::consts::FRAC_PI_3))));
        }
        for i in 0..n {
            let hue = look.crew.get(i as usize).map_or(col, |s| colour(*s));
            p.spawn((Transform::from_xyz(0.0, 0.0, 0.005), Visibility::default(), Helper { i, n, r: orbit })).with_children(|h| {
                h.spawn((Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(mats, hue, 0.4)), Transform::from_xyz(0.0, 0.0, -0.1).with_scale(Vec3::splat(5.0))));
                h.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(mats, hue, 0.85)), Transform::from_scale(Vec3::splat(1.4))));
            });
        }
        let lift = reach * 0.62 + if n > 0 { 9.0 } else { 5.0 };
        let ring = kit.shape(meshes, Shape::Ring(110));
        let mut part = |p: &mut ChildSpawnerCommands, i: u32, hex: u32, alpha: f32, size: f32, own: bool, mesh: &Handle<Mesh>| {
            let paint = if own { mats.add(ColorMaterial { color: srgba(hex, alpha), alpha_mode: AlphaMode2d::Blend, ..default() }) } else { kit.paint(mats, hex, alpha) };
            p.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(paint.clone()), Transform::from_xyz(0.0, 0.0, 0.015).with_scale(Vec3::splat(size)), Motion { act: look.act, i, r: reach, lift, paint: own.then_some(paint) }));
        };
        match look.act {
            Act::Make => (0..5).for_each(|i| part(p, i, GOLDEN, 0.95, 1.4, false, &circle)),
            Act::Look => (0..5).for_each(|i| part(p, i, WORK, 0.9 - 0.17 * i as f32, 1.4 - 0.16 * i as f32, false, &circle)),
            Act::Check => part(p, 0, WORK, 0.5, reach, true, &ring),
            Act::Say | Act::Think => (0..3).for_each(|i| part(p, i, if look.act == Act::Say { WORK } else { THINK }, 0.95, 1.25, false, &circle)),
            Act::None => {}
        }
    });
    hull
}

const GOLDEN: u32 = 0xFFD98A;

fn orbit(i: u32, n: u32, r: f32, phase: f32, t: f32) -> Vec2 {
    let shell = i % 3;
    let per_shell = n.div_ceil(3).max(1);
    let an = t * (2.4 - 0.3 * shell as f32) + (i / 3) as f32 * TAU / per_shell as f32 + phase + shell as f32;
    let (rx, ry) = (r + 11.0, (r + 11.0) * 0.36);
    let p = Vec2::new(an.cos() * rx, an.sin() * ry);
    let tilt = shell as f32 * std::f32::consts::FRAC_PI_3;
    let (s, c) = tilt.sin_cos();
    Vec2::new(p.x * c - p.y * s, p.x * s + p.y * c)
}

fn hash(x: f32) -> f32 {
    (x.sin() * 43_758.547).fract().abs()
}

fn work(time: Res<Time>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>, agents: Query<&Agent>, mut parts: Query<(&Motion, &ChildOf, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (m, parent, mut tf) in &mut parts {
        pace.ask(MOVING);
        let ph = agents.get(parent.parent()).map(|a| a.phase).unwrap_or(0.0);
        let i = m.i as f32;
        match m.act {
            Act::Make => {
                let k = t / 0.5 + i / 5.0 + ph;
                let u = k.fract();
                let a = -0.9 + 1.8 * hash(k.floor() * 7.13 + i * 1.7 + ph);
                let at = Vec2::new(m.r * 0.72, 0.0) + Vec2::from_angle(a) * (2.0 + 13.0 * u);
                tf.translation = at.extend(0.015);
                tf.scale = Vec3::splat(1.5 * (1.0 - u));
            }
            Act::Look => {
                let sweep = 0.75 * (t * 2.6 + ph).sin();
                let at = Vec2::from_angle(sweep) * (m.r + 3.0 + 4.5 * i);
                tf.translation = at.extend(0.015);
            }
            Act::Check => {
                let u = (t / 1.2 + ph).fract();
                tf.scale = Vec3::splat(m.r * 0.7 + 12.0 * u);
                if let Some(mut mat) = m.paint.as_ref().and_then(|p| mats.get_mut(p)) {
                    mat.color = fade(mat.color, 0.55 * (1.0 - u));
                }
            }
            Act::Say | Act::Think => {
                let bob = (t * 6.0 - i * 0.9 + ph).sin().max(0.0);
                tf.translation = Vec3::new((i - 1.0) * 4.0, m.lift + 1.8 * bob, 0.015);
            }
            Act::None => {}
        }
    }
}

fn burn(time: Res<Time>, current: Res<Current>, mut pace: ResMut<Pace>, mut flames: Query<(&Flame, &mut Transform)>) {
    if current.0.reduced {
        return;
    }
    let t = time.elapsed_secs();
    for (f, mut tf) in &mut flames {
        pace.ask(MOVING);
        let flicker = 0.75 + 0.35 * hash((t * 14.0).floor() + f.tail * 3.1 + tf.translation.x);
        tf.scale = Vec3::new(flicker, 1.0, 1.0);
    }
}

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
        tf.scale = Vec3::splat(0.6 + 0.8 * (1.0 - (2.0 * u - 1.0).abs()));
    }
}

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
    mut agents: Query<(&mut Agent, &mut Transform), Without<Hull>>,
    mut hulls: Query<&mut Transform, With<Hull>>,
) {
    let reduced = current.0.reduced;
    let dt = time.delta_secs();
    let t = time.elapsed_secs();
    let k = if reduced { 1.0 } else { 1.0 - (-dt * 2.6).exp() };
    let glow = kit.shape(&mut meshes, Shape::Glow);
    for (mut a, mut tf) in &mut agents {
        let to = frame.at(a.target.x, a.target.y, Z);
        let d = to - tf.translation;
        let dist = d.truncate().length();
        if dist < 0.2 {
            tf.translation = to;
        } else {
            let step = d * k;
            if !reduced && step.truncate().length() > 0.8 {
                let size = a.look.r * 3.0;
                let paint = kit.paint(&mut mats, colour(a.look.state), 0.5);
                commands.spawn((Mesh2d(glow.clone()), MeshMaterial2d(paint), Transform::from_translation(tf.translation.with_z(Z - 0.05)).with_scale(Vec3::splat(size)), Puff { born: t, size }));
            }
            tf.translation += step;
            pace.ask(MOVING);
        }
        let stuck = a.look.state == State::Stuck;
        let rest = if stuck && !reduced { -0.5 + 0.1 * (t * 1.3 + a.phase).sin() } else { 0.0 };
        let want = if dist > 4.0 { d.y.atan2(d.x) } else { rest };
        let diff = (want - a.heading + PI).rem_euclid(TAU) - PI;
        a.heading = if reduced { want } else { a.heading + diff * (1.0 - (-dt * 7.0).exp()) };
        if diff.abs() > 0.01 && !reduced {
            pace.ask(MOVING);
        }
        let live = matches!(a.look.state, State::Work | State::Think) && !reduced;
        if let Ok(mut h) = hulls.get_mut(a.hull) {
            h.rotation = Quat::from_rotation_z(a.heading);
            h.translation.y = if live && dist < 4.0 { 1.1 * (t * 1.4 + a.phase).sin() } else { 0.0 };
        }
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
            m.color = fade(m.color, al);
        }
    }
}

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
