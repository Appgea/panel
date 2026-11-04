//! The space behind everything: the night fill (the clear colour) and a faint dot every 32 world
//! pixels over a wide field, so a drag shows the map moving.

use crate::draw::{Kit, INK_3};
use crate::Step;
use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

/// Half the field's side, in world pixels. The map's edges sit well inside it.
const FIELD: f32 = 2400.0;
const EVERY: f32 = 32.0;

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Startup, setup.in_set(Step::Draw));
}

/// Every grid dot as one 1.2 px square, in one mesh, so the grid costs one draw.
fn grid() -> Mesh {
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    let s = 1.2;
    let mut x = -FIELD;
    while x <= FIELD {
        let mut y = -FIELD;
        while y <= FIELD {
            let n = pos.len() as u32;
            pos.extend([[x, y, 0.0], [x + s, y, 0.0], [x + s, y - s, 0.0], [x, y - s, 0.0]]);
            idx.extend([n, n + 1, n + 2, n, n + 2, n + 3]);
            y += EVERY;
        }
        x += EVERY;
    }
    let count = pos.len();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; count])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count])
        .with_inserted_indices(Indices::U32(idx))
}

fn setup(mut commands: Commands, mut kit: ResMut<Kit>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    let grid = meshes.add(grid());
    commands.spawn((Mesh2d(grid), MeshMaterial2d(kit.paint(&mut mats, INK_3, 0.14)), Transform::from_xyz(0.0, 0.0, -0.9)));
}
