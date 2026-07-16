"""GLB-writer: meshes -> glTF 2.0 binary met vertex colors en klasse-materialen.

Conventies (zie plan):
- neutrale bake: materiaal-baseColor = klasse-kleur, COLOR_0 = subtiele
  per-vertex/per-object variatie (bijna wit). Elke engine toont zo direct
  iets zinnigs; de client mag de klasse-kleur overschrijven via het palet.
- naamgeving: elke mesh/node heet "class:<klasse>" zodat de viewer (en
  later Unity/Godot/Unreal) semantiek kan herkennen zonder extensies.
- assenstelsel: pipeline is x=oost, y=noord, z=omhoog; glTF is Y-up.
  Conversie: (x, y, z) -> (x, z, -y).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pygltflib

from .meshes import Mesh

# Neutrale bake-kleuren per klasse (lineaire RGB)
CLASS_COLORS = {
    "grass": [0.36, 0.48, 0.26, 1.0],
    "roof": [0.52, 0.28, 0.22, 1.0],
    "wall": [0.72, 0.68, 0.60, 1.0],
    "ground": [0.45, 0.42, 0.38, 1.0],
    "road": [0.38, 0.38, 0.41, 1.0],
    "water": [0.28, 0.42, 0.52, 1.0],
}


def _to_gltf_axes(positions: np.ndarray) -> np.ndarray:
    out = np.empty_like(positions)
    out[:, 0] = positions[:, 0]
    out[:, 1] = positions[:, 2]
    out[:, 2] = -positions[:, 1]
    return out


def write_glb(meshes: list[Mesh], out_path: str | Path, extras: dict | None = None) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    gltf = pygltflib.GLTF2(
        asset=pygltflib.Asset(
            version="2.0",
            generator="local-damage pipeline",
            copyright="Data: (c) 3DBAG by tudelft3d and 3DGI (CC BY 4.0); AHN/PDOK",
        )
    )
    gltf.scenes = [pygltflib.Scene(nodes=[])]
    gltf.scene = 0

    blob = bytearray()

    def add_accessor(arr: np.ndarray, target: int, ctype: int, atype: str, minmax: bool = False) -> int:
        data = arr.tobytes()
        # 4-byte alignment
        while len(blob) % 4:
            blob.extend(b"\x00")
        offset = len(blob)
        blob.extend(data)
        gltf.bufferViews.append(
            pygltflib.BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target)
        )
        acc = pygltflib.Accessor(
            bufferView=len(gltf.bufferViews) - 1,
            componentType=ctype,
            count=len(arr),
            type=atype,
        )
        if minmax:
            acc.min = arr.min(axis=0).tolist()
            acc.max = arr.max(axis=0).tolist()
        gltf.accessors.append(acc)
        return len(gltf.accessors) - 1

    material_by_class: dict[str, int] = {}

    def material_for(cls: str) -> int:
        if cls not in material_by_class:
            color = CLASS_COLORS.get(cls, [0.7, 0.7, 0.7, 1.0])
            gltf.materials.append(
                pygltflib.Material(
                    name=f"class:{cls}",
                    pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                        baseColorFactor=color, metallicFactor=0.0, roughnessFactor=1.0
                    ),
                    doubleSided=(cls in ("road", "water")),
                )
            )
            material_by_class[cls] = len(gltf.materials) - 1
        return material_by_class[cls]

    for mesh in meshes:
        positions = _to_gltf_axes(mesh.positions.astype(np.float32))
        normals = _to_gltf_axes(mesh.normals.astype(np.float32))
        colors = mesh.colors.astype(np.float32)
        indices = mesh.indices.astype(np.uint32).ravel()

        pos_acc = add_accessor(positions, pygltflib.ARRAY_BUFFER, pygltflib.FLOAT, "VEC3", minmax=True)
        nrm_acc = add_accessor(normals, pygltflib.ARRAY_BUFFER, pygltflib.FLOAT, "VEC3")
        col_acc = add_accessor(colors, pygltflib.ARRAY_BUFFER, pygltflib.FLOAT, "VEC3")
        idx_acc = add_accessor(indices, pygltflib.ELEMENT_ARRAY_BUFFER, pygltflib.UNSIGNED_INT, "SCALAR")

        gltf.meshes.append(
            pygltflib.Mesh(
                name=mesh.name,
                primitives=[
                    pygltflib.Primitive(
                        attributes=pygltflib.Attributes(
                            POSITION=pos_acc, NORMAL=nrm_acc, COLOR_0=col_acc
                        ),
                        indices=idx_acc,
                        material=material_for(mesh.cls),
                        mode=pygltflib.TRIANGLES,
                    )
                ],
            )
        )
        # klasse ook in extras: node-namen worden door sommige loaders gesaneerd
        # (three.js strookt ':' eruit), extras komen ongewijzigd door in userData
        gltf.nodes.append(
            pygltflib.Node(name=mesh.name, mesh=len(gltf.meshes) - 1, extras={"cls": mesh.cls})
        )
        gltf.scenes[0].nodes.append(len(gltf.nodes) - 1)

    if extras:
        gltf.scenes[0].extras = extras

    gltf.buffers = [pygltflib.Buffer(byteLength=len(blob))]
    gltf.set_binary_blob(bytes(blob))
    gltf.save_binary(str(out_path))
    return out_path


def write_manifest(out_dir: str | Path, areas: list[dict]) -> Path:
    """dist/tiles/index.json — welke gebieden er zijn en waar ze vandaan komen."""
    out = Path(out_dir) / "index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"version": 1, "areas": areas}, indent=2))
    return out
