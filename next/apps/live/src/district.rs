//! The districts: one rounded box per project with something going on, holding a row per agent.
//! A faint floor and an edge that turns amber for a card and red for a stuck agent.

use crate::draw::{edge_shape, rect_shape, Frame, Kit, FAIL, LINE, LINE_2, RAISE, WAIT, WALL};
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
}
