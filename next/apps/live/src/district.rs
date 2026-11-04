//! The districts: one circle per project with something going on, drawn like a large atom. A
//! faint floor, an edge that turns amber for a card and red for a stuck agent, and two thin
//! orbit rings inside. The files agents touched are small tiles that glow while fresh.

use crate::draw::{tenth, Frame, Kit, Shape, DONE, FAIL, LINE, LINE_2, RAISE, WAIT, WALL, WORK};
use crate::{Current, Edge, Step};
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
    let frame = *frame;
    let mut put = |mesh: Handle<Mesh>, mat: Handle<ColorMaterial>, t: Transform| {
        commands.spawn((Drawn, Mesh2d(mesh), MeshMaterial2d(mat), t));
    };
    let circle = kit.shape(&mut meshes, Shape::Circle);
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let square = kit.shape(&mut meshes, Shape::Square);
    for d in &current.0.districts {
        let at = |z: f32, s: f32| Transform::from_translation(frame.at(d.x, d.y, z)).with_scale(Vec3::splat(s));
        put(circle.clone(), kit.paint(&mut mats, if d.selected { RAISE } else { WALL }, 0.72), at(0.0, d.r));
        let (hex, alpha) = match d.edge {
            Edge::Stuck => (FAIL, 0.55),
            Edge::Card => (WAIT, 0.45),
            Edge::Quiet if d.selected => (LINE_2, 1.0),
            Edge::Quiet => (LINE, 1.0),
        };
        let edge = kit.shape(&mut meshes, Shape::Ring((1.0 / d.r * 1000.0).round().max(1.0) as i32));
        put(edge, kit.paint(&mut mats, hex, alpha), at(0.02, d.r));
        // Two orbits, tilted, like the shells of an atom. Only decoration, so very faint.
        for (i, tilt) in [0.35f32, -0.35].iter().enumerate() {
            let (rx, ry) = (d.r * 0.78, d.r * (0.30 + 0.06 * i as f32));
            let shell = kit.shape(&mut meshes, Shape::Ellipse(tenth(rx), tenth(ry), 8));
            put(shell, kit.paint(&mut mats, LINE_2, 0.55), Transform::from_translation(frame.at(d.x, d.y, 0.01)).with_rotation(Quat::from_rotation_z(*tilt)));
        }
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
