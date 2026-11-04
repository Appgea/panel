//! This Mac at the middle of the map with its testlock bays, and the landmarks agents travel to:
//! the GitHub tower and the web gate. Shapes only.
//! - The hub is `--deck` with a `--line` edge. A hot Mac warms both toward amber.
//! - A held bay is cyan at 7% with a cyan edge at 35%.

use crate::draw::{edge_shape, line, rect_shape, Frame, Kit, Shape, DECK, INK_3, LINE, LINE_2, THINK, WAIT, WALL, WORK};
use crate::{Current, LandmarkKind, Step};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, redraw.run_if(resource_changed::<Current>).in_set(Step::Draw));
}

fn redraw(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    current: Res<Current>,
    frame: Res<Frame>,
    old: Query<Entity, With<Drawn>>,
) {
    for e in &old {
        commands.entity(e).despawn();
    }
    let frame = *frame;
    let mut put = |mesh: Handle<Mesh>, mat: Handle<ColorMaterial>, t: Transform| {
        commands.spawn((Drawn, Mesh2d(mesh), MeshMaterial2d(mat), t));
    };
    let boxed = |kit: &mut Kit, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, put: &mut dyn FnMut(Handle<Mesh>, Handle<ColorMaterial>, Transform), x: f32, y: f32, w: f32, h: f32, r: f32, fill: (u32, f32), edge: (u32, f32), z: f32| {
        let at = Transform::from_translation(frame.at(x, y, z));
        put(kit.shape(meshes, rect_shape(w, h, r)), kit.paint(mats, fill.0, fill.1), at);
        put(kit.shape(meshes, edge_shape(w, h, r, 1.0)), kit.paint(mats, edge.0, edge.1), at.with_translation(at.translation.with_z(z + 0.01)));
    };
    let square = kit.shape(&mut meshes, Shape::Square);
    let glow = kit.shape(&mut meshes, Shape::Glow);
    if let Some(h) = &current.0.hub {
        let edge = if h.hot { (WAIT, 0.55) } else { (LINE, 1.0) };
        boxed(&mut kit, &mut meshes, &mut mats, &mut put, h.x, h.y, h.w, h.h, 12.0, (DECK, 1.0), edge, 0.0);
        if h.hot {
            put(kit.shape(&mut meshes, rect_shape(h.w, h.h, 12.0)), kit.paint(&mut mats, WAIT, 0.08), Transform::from_translation(frame.at(h.x, h.y, 0.005)));
        }
        for b in &h.bays {
            let (fill, edge) = if b.held { ((WORK, 0.07), (WORK, 0.35)) } else { ((WALL, 1.0), (LINE, 1.0)) };
            boxed(&mut kit, &mut meshes, &mut mats, &mut put, b.x, b.y, b.w, b.h, 7.0, fill, edge, 0.05);
        }
    }
    for l in &current.0.landmarks {
        let at = |dx: f32, dy: f32, z: f32| Transform::from_translation(frame.at(l.x + dx, l.y + dy, z));
        match l.kind {
            LandmarkKind::Tower => {
                // A mast of light: a base, a thin pillar with rungs, and a lit tip.
                boxed(&mut kit, &mut meshes, &mut mats, &mut put, l.x, l.y, 70.0, 14.0, 5.0, (DECK, 1.0), (LINE_2, 1.0), 0.0);
                let paint = kit.paint(&mut mats, LINE_2, 1.0);
                put(square.clone(), paint.clone(), line(frame, Vec2::new(l.x, l.y - 7.0), Vec2::new(l.x, l.y - 120.0), 0.02, 2.0));
                for i in 1..4 {
                    let y = l.y - 7.0 - i as f32 * 28.0;
                    let half = 16.0 - i as f32 * 4.0;
                    put(square.clone(), paint.clone(), line(frame, Vec2::new(l.x - half, y), Vec2::new(l.x + half, y), 0.02, 1.0));
                }
                put(square.clone(), kit.paint(&mut mats, WORK, 0.9), at(0.0, -124.0, 0.04).with_rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_4)).with_scale(Vec3::new(8.0, 8.0, 1.0)));
                put(glow.clone(), kit.paint(&mut mats, WORK, 0.45), at(0.0, -124.0, 0.03).with_scale(Vec3::splat(26.0)));
            }
            LandmarkKind::Web => {
                for (r, a) in [(40.0f32, 0.5f32), (27.0, 0.3)] {
                    let ring = kit.shape(&mut meshes, Shape::Ring((1.2 / r * 1000.0).round() as i32));
                    put(ring, kit.paint(&mut mats, THINK, a), at(0.0, 0.0, 0.02).with_scale(Vec3::splat(r)));
                }
                put(glow.clone(), kit.paint(&mut mats, THINK, 0.3), at(0.0, 0.0, 0.01).with_scale(Vec3::splat(44.0)));
                put(kit.shape(&mut meshes, Shape::Circle), kit.paint(&mut mats, INK_3, 0.6), at(0.0, 0.0, 0.03).with_scale(Vec3::splat(3.0)));
            }
            LandmarkKind::Unknown => {}
        }
    }
}
