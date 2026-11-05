//! The districts: one rounded box per project with something going on, holding a row per agent.
//! A faint floor and an edge that turns amber for a card and red for a stuck agent. The files
//! agents touched are small tiles along the bottom that glow while fresh.

use crate::draw::{edge_shape, rect_shape, Frame, Kit, Shape, DONE, FAIL, LINE, LINE_2, RAISE, WAIT, WALL, WORK};
use crate::{Current, Edge, Step};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

/// A plot's corner radius.
const CORNER: f32 = 12.0;

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, redraw.in_set(Step::Draw).run_if(resource_changed::<Current>));
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
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let square = kit.shape(&mut meshes, Shape::Square);
    for d in &current.0.districts {
        let at = |z: f32| Transform::from_translation(frame.at(d.x, d.y, z));
        let floor = kit.shape(&mut meshes, rect_shape(d.w, d.h, CORNER));
        put(floor, kit.paint(&mut mats, if d.selected { RAISE } else { WALL }, 0.72), at(0.0));
        let (hex, alpha) = match d.edge {
            Edge::Stuck => (FAIL, 0.55),
            Edge::Card => (WAIT, 0.45),
            Edge::Quiet if d.selected => (LINE_2, 1.0),
            Edge::Quiet => (LINE, 1.0),
        };
        let edge = kit.shape(&mut meshes, edge_shape(d.w, d.h, CORNER, 1.0));
        put(edge, kit.paint(&mut mats, hex, alpha), at(0.02));
    }
    for t in &current.0.tiles {
        let at = |z: f32| Transform::from_translation(frame.at(t.x, t.y, z));
        let hex = if t.edited { DONE } else { WORK };
        put(square.clone(), kit.paint(&mut mats, LINE_2, 1.0), at(0.1).with_scale(Vec3::new(5.0, 5.0, 1.0)));
        if t.lit > 0.05 {
            put(square.clone(), kit.paint(&mut mats, hex, 0.35 + 0.6 * t.lit), at(0.11).with_scale(Vec3::new(5.0, 5.0, 1.0)));
            put(glow.clone(), kit.paint(&mut mats, hex, 0.5 * t.lit), at(0.09).with_scale(Vec3::splat(12.0)));
        }
    }
}
