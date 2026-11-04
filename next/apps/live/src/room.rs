//! The rooms: their boxes and edges, the divider under the sign, the four station pads, the
//! shelf and the embers on it. Copied from `drawRoom` in the concept page, lines 869 to 912,
//! without its text, which is HTML.

use crate::draw::{edge_shape, rect_shape, tenth, Frame, Kit, Shape, DONE, FAIL, IDLE, LINE, LINE_2, RAISE, WAIT, WALL};
use crate::{Current, Edge, Outcome, Step};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, redraw.in_set(Step::Draw).run_if(resource_changed::<Current>));
}

fn outcome_colour(o: Outcome) -> u32 {
    match o {
        Outcome::Done => DONE,
        Outcome::Failed | Outcome::Crashed => FAIL,
        Outcome::Stopped => IDLE,
        Outcome::Stuck => WAIT,
    }
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
    let square = kit.shape(&mut meshes, Shape::Square);
    let circle = kit.shape(&mut meshes, Shape::Circle);
    let glow = kit.shape(&mut meshes, Shape::Glow);
    let crashed = kit.shape(&mut meshes, Shape::Ring(406)); // 1.3 px of a 3.2 px radius
    for r in &current.0.rooms {
        let centre = |z: f32| Transform::from_translation(frame.at(r.x + r.w / 2.0, r.y + r.h / 2.0, z));
        let fill = kit.paint(&mut mats, if r.selected { RAISE } else { WALL }, 1.0);
        put(kit.shape(&mut meshes, rect_shape(r.w, r.h, 10.0)), fill, centre(0.0));
        let edge = match r.edge {
            Edge::Stuck => kit.paint(&mut mats, FAIL, 0.55),
            Edge::Card => kit.paint(&mut mats, WAIT, 0.42),
            Edge::Quiet if r.selected => kit.paint(&mut mats, LINE_2, 1.0),
            Edge::Quiet => kit.paint(&mut mats, LINE, 1.0),
        };
        put(kit.shape(&mut meshes, edge_shape(r.w, r.h, 10.0, 1.0)), edge, centre(0.02));
        let line = kit.paint(&mut mats, LINE, 1.0);
        // The divider under the sign, and the shelf the embers stand on.
        for y in [r.divider_y, r.shelf_y + 8.5] {
            put(square.clone(), line.clone(), frame.boxed(r.x + 10.0, y - 0.5, r.w - 20.0, 1.0, 0.03));
        }
        let pad = kit.shape(&mut meshes, Shape::Ellipse(tenth(r.pad_rx), tenth(r.pad_ry), 10));
        let pad_paint = kit.paint(&mut mats, LINE_2, 0.6);
        for p in &r.pads {
            put(pad.clone(), pad_paint.clone(), Transform::from_translation(frame.at(p[0], p[1], 0.04)));
        }
        for (i, e) in r.embers.iter().enumerate() {
            let col = outcome_colour(e.outcome);
            let al = (0.85 - i as f32 * 0.07).max(0.32);
            let at = |z: f32| Transform::from_translation(frame.at(e.x, e.y, z));
            if e.outcome != Outcome::Stopped {
                put(glow.clone(), kit.paint(&mut mats, col, al * 0.55), at(0.05).with_scale(Vec3::splat(9.0)));
            }
            let core = if e.outcome == Outcome::Crashed { crashed.clone() } else { circle.clone() };
            put(core, kit.paint(&mut mats, col, al), at(0.06).with_scale(Vec3::splat(3.2)));
        }
    }
}
