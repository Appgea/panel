use crate::draw::{arc, edge_shape, fade, rect_shape, shaded_disc, slab, srgba, Frame, Kit, Pace, Shape, BLINKING, FAIL, GOLD, INK, LINE, LINE_2, MOVING, RAISE, VOID, WAIT, WALL};
use crate::{Current, Edge, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::f32::consts::{FRAC_PI_4, PI, TAU};

#[derive(Component)]
struct Drawn;

#[derive(Component)]
struct Moon {
    at: Vec3,
    i: u32,
    n: u32,
}

#[derive(Component)]
struct Alarm {
    paint: Handle<ColorMaterial>,
}

const CORNER: f32 = 14.0;
const R: f32 = 17.0;
const TILT: f32 = -0.3;
const MAX_MOONS: u32 = 10;
const BANDS: [&[(&str, f32, f32, bool)]; 4] = [
    &[("band-a", 0.14, 0.4, true), ("band-b", -0.6, -0.36, false)],
    &[("band-c", -0.12, 0.1, true), ("band-d", 0.5, 0.7, true)],
    &[("band-e", -0.5, -0.05, true)],
    &[("band-f", 0.3, 0.52, false), ("band-g", -0.2, 0.0, true), ("band-h", -0.72, -0.56, true)],
];

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, (redraw.run_if(resource_changed::<Current>), turn).chain().in_set(Step::Draw));
}

#[allow(clippy::too_many_arguments)]
fn redraw(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    current: Res<Current>,
    frame: Res<Frame>,
    old: Query<(Entity, Option<&Alarm>), With<Drawn>>,
) {
    for (e, alarm) in &old {
        if let Some(a) = alarm {
            mats.remove(&a.paint);
        }
        commands.entity(e).despawn();
    }
    let frame = *frame;
    for d in &current.0.districts {
        let floor = kit.shape(&mut meshes, rect_shape(d.w, d.h, CORNER));
        let at = |z: f32| Transform::from_translation(frame.at(d.x, d.y, z));
        commands.spawn((Drawn, Mesh2d(floor), MeshMaterial2d(kit.paint(&mut mats, if d.selected { RAISE } else { WALL }, if d.selected { 0.7 } else { 0.42 })), at(0.0)));
        let (hex, alpha) = match d.edge {
            Edge::Stuck => (FAIL, 0.4),
            Edge::Card => (WAIT, 0.34),
            Edge::Quiet if d.selected => (LINE_2, 1.0),
            Edge::Quiet => (LINE, 0.6),
        };
        let edge = kit.shape(&mut meshes, edge_shape(d.w, d.h, CORNER, 1.0));
        commands.spawn((Drawn, Mesh2d(edge), MeshMaterial2d(kit.paint(&mut mats, hex, alpha)), at(0.02)));

        let hue = crate::hex(d.hue.as_deref());
        let p = |z: f32| frame.at(d.px, d.py, z);
        let glow = kit.shape(&mut meshes, Shape::Glow);
        commands.spawn((Drawn, Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, 0.5)), Transform::from_translation(p(0.08)).with_scale(Vec3::splat(R * 3.4))));
        let body = kit.named(&mut meshes, "planet", shaded_disc);
        commands.spawn((Drawn, Mesh2d(body), MeshMaterial2d(kit.paint(&mut mats, hue, 1.0)), Transform::from_translation(p(0.1)).with_scale(Vec3::splat(R))));
        for (name, a, b, dark) in BANDS[d.bands as usize % BANDS.len()] {
            let band = kit.named(&mut meshes, *name, || slab(*a, *b));
            let paint = if *dark { kit.paint(&mut mats, VOID, 0.3) } else { kit.paint(&mut mats, 0xFFFFFF, 0.16) };
            commands.spawn((Drawn, Mesh2d(band), MeshMaterial2d(paint), Transform::from_translation(p(0.11)).with_rotation(Quat::from_rotation_z(-0.22)).with_scale(Vec3::splat(R))));
        }
        if d.ringed {
            let tilt = Quat::from_rotation_z(TILT);
            let back = kit.named(&mut meshes, "ring-back", || arc(1.78, 0.5, 0.13, 0.0, PI));
            let front = kit.named(&mut meshes, "ring-front", || arc(1.78, 0.5, 0.13, PI, TAU));
            let paint = kit.paint(&mut mats, INK, 0.55);
            commands.spawn((Drawn, Mesh2d(back), MeshMaterial2d(paint.clone()), Transform::from_translation(p(0.09)).with_rotation(tilt).with_scale(Vec3::splat(R))));
            commands.spawn((Drawn, Mesh2d(front), MeshMaterial2d(paint), Transform::from_translation(p(0.12)).with_rotation(tilt).with_scale(Vec3::splat(R))));
        }
        if d.selected {
            let ring = kit.shape(&mut meshes, Shape::Ring(60));
            commands.spawn((Drawn, Mesh2d(ring), MeshMaterial2d(kit.paint(&mut mats, INK, 0.8)), Transform::from_translation(p(0.14)).with_scale(Vec3::splat(R + 6.0))));
        }
        if d.edge != Edge::Quiet && !current.0.reduced {
            let hex = if d.edge == Edge::Stuck { FAIL } else { WAIT };
            let paint = mats.add(ColorMaterial { color: srgba(hex, 0.0), alpha_mode: AlphaMode2d::Blend, ..default() });
            let ring = kit.shape(&mut meshes, Shape::Ring(70));
            commands.spawn((Drawn, Alarm { paint: paint.clone() }, Mesh2d(ring), MeshMaterial2d(paint), Transform::from_translation(p(0.15)).with_scale(Vec3::splat(R))));
        }
        let n = d.trophies.min(MAX_MOONS);
        let square = kit.shape(&mut meshes, Shape::Square);
        for i in 0..n {
            commands.spawn((Drawn, Moon { at: p(0.0), i, n }, Transform::default(), Visibility::default())).with_children(|m| {
                m.spawn((Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, GOLD, 0.55)), Transform::from_xyz(0.0, 0.0, -0.005).with_scale(Vec3::splat(7.0))));
                m.spawn((Mesh2d(square.clone()), MeshMaterial2d(kit.paint(&mut mats, GOLD, 1.0)), Transform::from_rotation(Quat::from_rotation_z(FRAC_PI_4)).with_scale(Vec3::new(3.0, 3.0, 1.0))));
            });
        }
    }
}

fn turn(time: Res<Time>, current: Res<Current>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>, mut moons: Query<(&Moon, &mut Transform), Without<Alarm>>, mut alarms: Query<(&Alarm, &mut Transform), Without<Moon>>) {
    let reduced = current.0.reduced;
    let t = if reduced { 0.0 } else { time.elapsed_secs() };
    let (sin, cos) = TILT.sin_cos();
    for (m, mut tf) in &mut moons {
        if !reduced {
            pace.ask(BLINKING);
        }
        let a = t * 0.3 + m.i as f32 * TAU / m.n as f32;
        let (x, y) = (a.cos() * R * 1.85, a.sin() * R * 0.58);
        let z = if a.sin() > 0.0 { 0.085 } else { 0.13 };
        tf.translation = m.at + Vec3::new(x * cos - y * sin, x * sin + y * cos, z);
    }
    for (a, mut tf) in &mut alarms {
        pace.ask(MOVING);
        let u = (t / 1.6).fract();
        tf.scale = Vec3::splat(R + 4.0 + 16.0 * u);
        if let Some(mut m) = mats.get_mut(&a.paint) {
            m.color = fade(m.color, 0.7 * (1.0 - u));
        }
    }
}
