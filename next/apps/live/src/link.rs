//! Family lines: dashed [2, 4] at 35% ink, from the hovered or selected dot to its parent and
//! children. Nothing else on the map is wired: cables over the map read as noise.

use crate::draw::{dashes, Frame, Kit, Shape, INK};
use crate::{Current, Step};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

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
    let square = kit.shape(&mut meshes, Shape::Square);
    let family = kit.paint(&mut mats, INK, 0.35);
    for l in &current.0.links {
        for t in dashes(*frame, l.a(), l.b(), 0.2, 1.0, 2.0, 4.0) {
            commands.spawn((Drawn, Mesh2d(square.clone()), MeshMaterial2d(family.clone()), t));
        }
    }
}
