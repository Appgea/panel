use crate::draw::{arc, edge_shape, fade, parts, rect_shape, srgba, Frame, Kit, Pace, Shape, BLINKING, DECK, HULL, LINE, MOVING, THINK, VOID, WAIT, WALL, WORK};
use crate::{Current, LandmarkKind, Step, STATION};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, PI, TAU};

#[derive(Component)]
struct Drawn;

#[derive(Component)]
struct Spin {
    speed: f32,
    phase: f32,
}

#[derive(Component)]
struct Wave {
    i: u32,
    paint: Handle<ColorMaterial>,
}

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, (redraw.run_if(resource_changed::<Current>), animate).chain().in_set(Step::Draw));
}

#[allow(clippy::too_many_arguments)]
fn redraw(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    current: Res<Current>,
    frame: Res<Frame>,
    time: Res<Time>,
    old: Query<(Entity, Option<&Wave>), With<Drawn>>,
) {
    for (e, wave) in &old {
        if let Some(w) = wave {
            mats.remove(&w.paint);
        }
        commands.entity(e).despawn();
    }
    let frame = *frame;
    let reduced = current.0.reduced;
    let t = if reduced { 0.0 } else { time.elapsed_secs() };
    let square = kit.shape(&mut meshes, Shape::Square);
    let circle = kit.shape(&mut meshes, Shape::Circle);
    let glow = kit.shape(&mut meshes, Shape::Glow);

    if let Some(h) = &current.0.hub {
        let edge = if h.hot { (WAIT, 0.55) } else { (LINE, 0.7) };
        boxed(&mut commands, &mut kit, &mut meshes, &mut mats, frame, (h.x, h.y, h.w, h.h, 14.0), (DECK, 0.6), edge, 0.0);
        if h.hot {
            put(&mut commands, kit.shape(&mut meshes, rect_shape(h.w, h.h, 14.0)), kit.paint(&mut mats, WAIT, 0.08), Transform::from_translation(frame.at(h.x, h.y, 0.005)));
        }
        for b in &h.bays {
            let (fill, edge) = if b.held { ((WORK, 0.1), (WORK, 0.5)) } else { ((WALL, 0.8), (LINE, 1.0)) };
            boxed(&mut commands, &mut kit, &mut meshes, &mut mats, frame, (b.x, b.y, b.w, b.h, 8.0), fill, edge, 0.05);
            if b.held {
                put(&mut commands, glow.clone(), kit.paint(&mut mats, WORK, 0.3), Transform::from_translation(frame.at(b.x + b.w / 2.0 - 16.0, b.y, 0.06)).with_scale(Vec3::splat(26.0)));
            }
        }
        let s = h.station();
        let metal = if h.hot { WAIT } else { HULL };
        put(&mut commands, glow.clone(), kit.paint(&mut mats, if h.hot { WAIT } else { WORK }, 0.4), Transform::from_translation(frame.at(s.x, s.y, 0.06)).with_scale(Vec3::splat(62.0)));
        let ring = kit.shape(&mut meshes, Shape::Ring(150));
        commands
            .spawn((Drawn, Spin { speed: 0.16, phase: 0.0 }, Transform::from_translation(frame.at(s.x, s.y, 0.1)).with_rotation(Quat::from_rotation_z(t * 0.16)), Visibility::default()))
            .with_children(|p| {
                p.spawn((Mesh2d(ring), MeshMaterial2d(kit.paint(&mut mats, metal, 0.95)), Transform::from_scale(Vec3::splat(19.0))));
                for k in 0..4 {
                    let a = k as f32 * FRAC_PI_2;
                    let dir = Vec2::from_angle(a);
                    p.spawn((Mesh2d(square.clone()), MeshMaterial2d(kit.paint(&mut mats, metal, 0.6)), Transform::from_translation((dir * 11.5).extend(0.0)).with_rotation(Quat::from_rotation_z(a)).with_scale(Vec3::new(11.0, 1.6, 1.0))));
                    let m = Vec2::from_angle(a + FRAC_PI_4) * 17.6;
                    p.spawn((Mesh2d(square.clone()), MeshMaterial2d(kit.paint(&mut mats, WORK, 1.0)), Transform::from_translation(m.extend(0.01)).with_rotation(Quat::from_rotation_z(a + FRAC_PI_4)).with_scale(Vec3::new(5.4, 5.4, 1.0))));
                }
                p.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(&mut mats, metal, 1.0)), Transform::from_xyz(0.0, 0.0, 0.01).with_scale(Vec3::splat(6.6))));
                p.spawn((Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(&mut mats, VOID, 1.0)), Transform::from_xyz(0.0, 0.0, 0.02).with_scale(Vec3::splat(2.8))));
            });
    }

    for l in &current.0.landmarks {
        boxed(&mut commands, &mut kit, &mut meshes, &mut mats, frame, (l.x, l.y, l.w, l.h, 14.0), (DECK, 0.6), (LINE, 0.7), 0.0);
        let at = Vec2::new(l.x - l.w / 2.0 + STATION.x, l.y - l.h / 2.0 + STATION.y);
        let here = |dx: f32, dy: f32, z: f32| Transform::from_translation(frame.at(at.x, at.y, z) + Vec3::new(dx, dy, 0.0));
        match l.kind {
            LandmarkKind::Tower => {
                let hue = WORK;
                commands.spawn((Drawn, Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, if l.quiet { 0.22 } else { 0.6 })), here(0.0, 0.0, 0.06).with_scale(Vec3::splat(64.0))));
                commands.spawn((Drawn, Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(&mut mats, VOID, 1.0)), here(0.0, 0.0, 0.08).with_scale(Vec3::splat(15.0))));
                commands.spawn((Drawn, Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, if l.quiet { 0.2 } else { 0.55 })), here(0.0, 0.0, 0.09).with_scale(Vec3::splat(15.0))));
                let ring = kit.shape(&mut meshes, Shape::Ring(170));
                let rim = if l.quiet { kit.paint(&mut mats, HULL, 0.6) } else { kit.paint(&mut mats, hue, 1.0) };
                commands.spawn((Drawn, Mesh2d(ring), MeshMaterial2d(rim), here(0.0, 0.0, 0.1).with_scale(Vec3::splat(17.5))));
                for k in 0..4 {
                    let a = FRAC_PI_4 + k as f32 * FRAC_PI_2;
                    let d = Vec2::from_angle(a) * 17.0;
                    commands.spawn((Drawn, Mesh2d(square.clone()), MeshMaterial2d(kit.paint(&mut mats, HULL, 1.0)), here(d.x, d.y, 0.11).with_rotation(Quat::from_rotation_z(a)).with_scale(Vec3::new(4.0, 7.0, 1.0))));
                }
                if !l.quiet && !reduced {
                    let swirl = kit.named(&mut meshes, "gate-swirl", || arc(1.0, 1.0, 0.18, 0.0, 2.0));
                    for k in 0..2 {
                        commands.spawn((Drawn, Spin { speed: -2.6, phase: k as f32 * PI }, Mesh2d(swirl.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, 0.85)), here(0.0, 0.0, 0.1).with_rotation(Quat::from_rotation_z(t * -2.6 + k as f32 * PI)).with_scale(Vec3::splat(10.5))));
                    }
                }
            }
            LandmarkKind::Web => {
                let hue = THINK;
                let tilt = Quat::from_rotation_z(-0.62);
                let up = tilt * Vec3::Y;
                commands.spawn((Drawn, Mesh2d(glow.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, if l.quiet { 0.18 } else { 0.45 })), here(0.0, 0.0, 0.06).with_scale(Vec3::splat(60.0))));
                let stand = kit.named(&mut meshes, "dish-stand", || parts(&[(vec![(-1.3, -13.0), (1.3, -13.0), (1.8, -3.0), (-1.8, -3.0)], 0.7), (vec![(-8.0, -15.5), (8.0, -15.5), (5.5, -12.5), (-5.5, -12.5)], 0.85)]));
                commands.spawn((Drawn, Mesh2d(stand), MeshMaterial2d(kit.paint(&mut mats, HULL, 0.9)), here(-3.0, 0.0, 0.09)));
                let bowl = kit.named(&mut meshes, "dish-bowl", || {
                    let rim: Vec<(f32, f32)> = (0..=16).map(|i| PI + PI * i as f32 / 16.0).map(|a| (a.cos() * 12.0, a.sin() * 6.5)).collect();
                    parts(&[(rim, 1.0)])
                });
                commands.spawn((Drawn, Mesh2d(bowl), MeshMaterial2d(kit.paint(&mut mats, HULL, 1.0)), here(-3.0, -1.0, 0.1).with_rotation(tilt)));
                let feed = Vec3::new(-3.0, -1.0, 0.0) + up * 5.5;
                commands.spawn((Drawn, Mesh2d(square.clone()), MeshMaterial2d(kit.paint(&mut mats, HULL, 0.8)), here(-3.0 + up.x * 2.5, -1.0 + up.y * 2.5, 0.1).with_rotation(tilt).with_scale(Vec3::new(1.2, 6.0, 1.0))));
                commands.spawn((Drawn, Mesh2d(circle.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, 1.0)), here(feed.x, feed.y, 0.11).with_scale(Vec3::splat(2.2))));
                let wave = kit.named(&mut meshes, "dish-wave", || arc(1.0, 1.0, 0.085, 0.3, 1.5));
                for i in 0..3u32 {
                    let size = 9.0 + 6.5 * i as f32;
                    let tf = here(feed.x, feed.y, 0.1).with_rotation(Quat::from_rotation_z(-0.1)).with_scale(Vec3::splat(size));
                    if l.quiet || reduced {
                        commands.spawn((Drawn, Mesh2d(wave.clone()), MeshMaterial2d(kit.paint(&mut mats, hue, 0.3)), tf));
                    } else {
                        let paint = mats.add(ColorMaterial { color: srgba(hue, 0.3), alpha_mode: AlphaMode2d::Blend, ..default() });
                        commands.spawn((Drawn, Wave { i, paint: paint.clone() }, Mesh2d(wave.clone()), MeshMaterial2d(paint), tf));
                    }
                }
            }
            LandmarkKind::Unknown => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn boxed(commands: &mut Commands, kit: &mut Kit, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, frame: Frame, (x, y, w, h, r): (f32, f32, f32, f32, f32), fill: (u32, f32), edge: (u32, f32), z: f32) {
    put(commands, kit.shape(meshes, rect_shape(w, h, r)), kit.paint(mats, fill.0, fill.1), Transform::from_translation(frame.at(x, y, z)));
    put(commands, kit.shape(meshes, edge_shape(w, h, r, 1.0)), kit.paint(mats, edge.0, edge.1), Transform::from_translation(frame.at(x, y, z + 0.01)));
}

fn put(commands: &mut Commands, mesh: Handle<Mesh>, mat: Handle<ColorMaterial>, t: Transform) {
    commands.spawn((Drawn, Mesh2d(mesh), MeshMaterial2d(mat), t));
}

fn animate(time: Res<Time>, current: Res<Current>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>, mut spins: Query<(&Spin, &mut Transform)>, waves: Query<&Wave>) {
    if current.0.reduced {
        return;
    }
    let t = time.elapsed_secs();
    for (s, mut tf) in &mut spins {
        pace.ask(if s.speed.abs() > 1.0 { MOVING } else { BLINKING });
        tf.rotation = Quat::from_rotation_z((t * s.speed + s.phase) % TAU);
    }
    for w in &waves {
        pace.ask(BLINKING);
        let u = (t * 0.9 - w.i as f32 * 0.28).fract();
        if let Some(mut m) = mats.get_mut(&w.paint) {
            m.color = fade(m.color, 0.15 + 0.75 * (1.0 - u) * (1.0 - u));
        }
    }
}
