//! This Mac at the middle of the map with its testlock bays, and the cards beside it that agents
//! travel to: GitHub and the web. Shapes only.
//! - The hub is `--deck` with a `--line` edge. A hot Mac warms both toward amber.
//! - A held bay is cyan at 7% with a cyan edge at 35%.
//! - A card with news lately is tinted 6% with a 40% edge in its hue: cyan GitHub, blue web.

use crate::draw::{edge_shape, rect_shape, Frame, Kit, DECK, LINE, THINK, WAIT, WALL, WORK};
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
    // GitHub and the web are cards like This Mac, so every place on the map reads the same way:
    // a box with its name and its news inside. Owner, 2026-11-06: keep them, but look better.
    for l in &current.0.landmarks {
        let hue = match l.kind {
            LandmarkKind::Tower => WORK,
            LandmarkKind::Web => THINK,
            LandmarkKind::Unknown => continue,
        };
        let (fill, edge) = if l.quiet { ((DECK, 1.0), (LINE, 1.0)) } else { ((hue, 0.06), (hue, 0.4)) };
        boxed(&mut kit, &mut meshes, &mut mats, &mut put, l.x, l.y, l.w, l.h, 12.0, (DECK, 1.0), (LINE, 1.0), 0.0);
        if !l.quiet {
            boxed(&mut kit, &mut meshes, &mut mats, &mut put, l.x, l.y, l.w, l.h, 12.0, fill, edge, 0.01);
        }
    }
}
