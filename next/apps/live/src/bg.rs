use crate::draw::{mesh, soft_disc, Kit};
use crate::Step;
use bevy::prelude::*;

const FIELD: f32 = 2600.0;
const STARS: u32 = 3000;
const CLOUDS: [(f32, f32, f32, u32, f32); 5] = [
    (-760.0, 120.0, 640.0, 0x5B4BD6, 0.16),
    (820.0, -420.0, 720.0, 0x1E8FA0, 0.13),
    (240.0, -1050.0, 600.0, 0x8A3FA0, 0.12),
    (-200.0, -520.0, 460.0, 0x2F5FD0, 0.10),
    (1500.0, 500.0, 560.0, 0x5B4BD6, 0.10),
];

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Startup, setup.in_set(Step::Draw));
}

fn stars() -> Mesh {
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut col: Vec<[f32; 4]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    for _ in 0..STARS {
        let (x, y) = ((next() * 2.0 - 1.0) * FIELD, (next() * 2.0 - 1.0) * FIELD);
        let depth = next();
        let bright = depth > 0.94;
        let s = if bright { 1.5 } else { 0.45 + 0.6 * depth };
        let a = if bright { 0.75 } else { 0.05 + 0.4 * depth * depth };
        let warm = next();
        let rgb = if warm > 0.86 { [1.0, 0.82, 0.62] } else if warm < 0.3 { [0.62, 0.8, 1.0] } else { [1.0, 1.0, 1.0] };
        let n = pos.len() as u32;
        if bright {
            pos.extend([[x - s * 1.6, y, 0.0], [x, y + s * 1.6, 0.0], [x + s * 1.6, y, 0.0], [x, y - s * 1.6, 0.0]]);
        } else {
            pos.extend([[x - s, y - s, 0.0], [x - s, y + s, 0.0], [x + s, y + s, 0.0], [x + s, y - s, 0.0]]);
        }
        col.extend([[rgb[0], rgb[1], rgb[2], a]; 4]);
        idx.extend([n, n + 1, n + 2, n, n + 2, n + 3]);
    }
    mesh(pos, idx).with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
}

fn setup(mut commands: Commands, mut kit: ResMut<Kit>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    let cloud = kit.named(&mut meshes, "cloud", soft_disc);
    for (x, y, r, hex, alpha) in CLOUDS {
        commands.spawn((Mesh2d(cloud.clone()), MeshMaterial2d(kit.paint(&mut mats, hex, alpha)), Transform::from_xyz(x, y, -0.95).with_scale(Vec3::splat(r))));
    }
    let field = meshes.add(stars());
    commands.spawn((Mesh2d(field), MeshMaterial2d(kit.paint(&mut mats, 0xFFFFFF, 1.0)), Transform::from_xyz(0.0, 0.0, -0.9)));
}
