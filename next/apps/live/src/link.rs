//! Lines between things. Copied from `drawLinks` in the concept page, lines 954 to 980.
//! - Family: dashed [2, 4] at 35% ink, from the hovered or selected dot to its parent and children.
//! - Bay: dashed cyan at 26%, from a bay holder's dot to its bay box.
//! - Threads: a bezier from each card's agent or room to the top of the ring, amber at 42% for
//!   the card in front and 12% for the rest.
//! - Tether: solid ink at 40%, from the selected dot to its panel.

use crate::draw::{bezier, dashes, line, Frame, Kit, Shape, INK, WAIT, WORK};
use crate::{Current, LinkKind, Step};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

/// Segments per thread: enough for a smooth curve at stage size.
const THREAD_STEPS: usize = 28;

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
    let square = kit.shape(&mut meshes, Shape::Square);
    let mut put = |mat: &Handle<ColorMaterial>, t: Transform| {
        commands.spawn((Drawn, Mesh2d(square.clone()), MeshMaterial2d(mat.clone()), t));
    };
    let family = kit.paint(&mut mats, INK, 0.35);
    let bay = kit.paint(&mut mats, WORK, 0.26);
    for l in &current.0.links {
        let mat = if l.kind == LinkKind::Family { &family } else { &bay };
        for t in dashes(frame, l.line.a(), l.line.b(), 0.2, 1.0, 2.0, 4.0) {
            put(mat, t);
        }
    }
    let front = kit.paint(&mut mats, WAIT, 0.42);
    let back = kit.paint(&mut mats, WAIT, 0.12);
    // The front thread draws last, over the others.
    let mut threads: Vec<_> = current.0.threads.iter().collect();
    threads.sort_by_key(|t| t.front);
    for (n, th) in threads.into_iter().enumerate() {
        let p = th.p.map(|q| Vec2::new(q[0], q[1]));
        let mat = if th.front { &front } else { &back };
        let z = 0.15 + n as f32 * 0.0005;
        let mut prev = p[0];
        for i in 1..=THREAD_STEPS {
            let next = bezier(p, i as f32 / THREAD_STEPS as f32);
            put(mat, line(frame, prev, next, z, 1.2));
            prev = next;
        }
    }
    if let Some(t) = current.0.tether {
        let tether = kit.paint(&mut mats, INK, 0.4);
        put(&tether, line(frame, t.a(), t.b(), 0.25, 1.0));
    }
}
