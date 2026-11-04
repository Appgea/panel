//! The stage behind everything: the night fill (the clear colour), a dot every 24 px at 16% of
//! ink-3, and a 14 px rounded border in `--line`. Copied from `drawBg` in the concept page,
//! line 838.

use crate::draw::{rounded_edge, Frame, Kit, INK_3, LINE};
use crate::{Current, Step};
use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

#[derive(Component)]
struct Drawn;

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Update, redraw.in_set(Step::Draw).run_if(resource_changed::<Current>));
}

/// Every grid dot as one 1 px square, in one mesh, so the grid costs one draw.
fn grid(w: f32, h: f32) -> Mesh {
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    let mut x = 12.0;
    while x < w {
        let mut y = 12.0;
        while y < h {
            let (px, py) = (x - w / 2.0, h / 2.0 - y);
            let n = pos.len() as u32;
            pos.extend([[px, py, 0.0], [px + 1.0, py, 0.0], [px + 1.0, py - 1.0, 0.0], [px, py - 1.0, 0.0]]);
            idx.extend([n, n + 1, n + 2, n, n + 2, n + 3]);
            y += 24.0;
        }
        x += 24.0;
    }
    let count = pos.len();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; count])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count])
        .with_inserted_indices(Indices::U32(idx))
}

#[allow(clippy::too_many_arguments)]
fn redraw(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    frame: Res<Frame>,
    old: Query<Entity, With<Drawn>>,
    mut size: Local<(f32, f32)>,
    mut made: Local<Vec<Handle<Mesh>>>,
) {
    if *size == (frame.w, frame.h) && !old.is_empty() {
        return;
    }
    *size = (frame.w, frame.h);
    for e in &old {
        commands.entity(e).despawn();
    }
    for h in made.drain(..) {
        meshes.remove(&h);
    }
    if frame.w < 2.0 || frame.h < 2.0 {
        return;
    }
    // Both meshes follow the stage size, so they are this module's own, not the shared cache's.
    let grid = meshes.add(grid(frame.w, frame.h));
    let edge = meshes.add(rounded_edge(frame.w, frame.h, 14.0, 1.0));
    *made = vec![grid.clone(), edge.clone()];
    commands.spawn((Drawn, Mesh2d(grid), MeshMaterial2d(kit.paint(&mut mats, INK_3, 0.16)), Transform::from_xyz(0.0, 0.0, -0.9)));
    commands.spawn((Drawn, Mesh2d(edge), MeshMaterial2d(kit.paint(&mut mats, LINE, 1.0)), Transform::from_xyz(0.0, 0.0, -0.8)));
}
