import * as T from "three";
import { buildBuffers, NODE_COLORS, NODE_RADII } from "./buffers";
import type { InstanceBuffer, SegmentBuffer } from "./buffers";
import type { SceneData } from "./types";

interface ProjectedSelection {
  kind: number;
  instance: number;
  position: T.Vector3;
  depth: number;
  size: number;
}

const nodeVertex = `
attribute float nodeAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 p = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelViewMatrix * instanceMatrix) * normal);
  vec3 color = instanceColor;
  if (nodeAlpha < 0.5) color = mix(color, vec3(dot(color, vec3(0.2126,0.7152,0.0722))), 0.75);
  vColor = color * (0.65 + 0.35 * abs(dot(n, normalize(vec3(0.3,0.6,1.0)))));
  vAlpha = nodeAlpha;
  gl_Position = projectionMatrix * p;
}`;
const nodeFragment = `
varying vec3 vColor; varying float vAlpha;
void main() {
  if(vAlpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, vAlpha);
  #include <colorspace_fragment>
}`;
const edgeVertex = `
attribute vec3 edgeColor; attribute float edgeAlpha; attribute float lineDistance;
varying vec3 vColor; varying float vAlpha; varying float vDistance;
void main() {
  vColor=edgeColor; vAlpha=edgeAlpha; vDistance=lineDistance;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`;
const edgeFragment = `
uniform bool dashed; uniform float density;
varying vec3 vColor; varying float vAlpha; varying float vDistance;
void main() {
  if(vAlpha<=0.0 || (dashed && mod(vDistance,5.0)>3.0)) discard;
  gl_FragColor=vec4(vColor,vAlpha > 0.5 ? vAlpha : vAlpha * density);
  #include <colorspace_fragment>
}`;
export class GpuBatches {
  readonly nodes: T.InstancedMesh<T.BufferGeometry, T.ShaderMaterial>[] = [];
  readonly edges: T.LineSegments<T.BufferGeometry, T.ShaderMaterial>[] = [];
  nodeIndices: number[][] = [];
  visibleNodes = 0;
  visibleEdges = 0;
  segments: SegmentBuffer[] = [];
  private buffers: InstanceBuffer[] = [];
  private positions: Float32Array = new Float32Array();
  private hovered: number | null = null;
  private selected: number | null = null;
  private readonly ring = new T.Mesh(
    new T.RingGeometry(1.12, 1.2, 32),
    new T.MeshBasicMaterial({
      color: 0xa6c4dd,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
    }),
  );
  constructor(
    private scene: T.Scene,
    data: SceneData,
  ) {
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    scene.add(this.ring);
    const counts = Array.from(
      { length: 5 },
      (_, k) => Array.from(data.nodes.kinds).filter((v) => v === k).length,
    );
    const geometries = [
      new T.SphereGeometry(NODE_RADII[0], 10, 7),
      new T.OctahedronGeometry(NODE_RADII[1]),
      new T.BoxGeometry(NODE_RADII[2]! * 1.5, NODE_RADII[2]! * 1.5, NODE_RADII[2]! * 1.5),
      new T.TetrahedronGeometry(NODE_RADII[3]),
      new T.TorusGeometry(1.9, 0.35, 4, 12),
    ];
    for (let k = 0; k < 5; k++) {
      const geometry = geometries[k]!;
      geometry.setAttribute(
        "nodeAlpha",
        new T.InstancedBufferAttribute(new Float32Array(counts[k]!), 1),
      );
      const material = new T.ShaderMaterial({
        vertexShader: nodeVertex,
        fragmentShader: nodeFragment,
        transparent: true,
        depthWrite: true,
        blending: T.NormalBlending,
      });
      const mesh = new T.InstancedMesh(geometry, material, counts[k]!);
      // No per-instance sorting; opaque active nodes write depth, edges do not.
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.visible = counts[k]! > 0;
      for (let i = 0; i < counts[k]!; i++) mesh.setColorAt(i, new T.Color(NODE_COLORS[k]));
      scene.add(mesh);
      this.nodes.push(mesh);
    }
    for (let s = 0; s < 2; s++) {
      const material = new T.ShaderMaterial({
        vertexShader: edgeVertex,
        fragmentShader: edgeFragment,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: T.NormalBlending,
        uniforms: { dashed: { value: s === 1 }, density: { value: 1 } },
      });
      const line = new T.LineSegments(new T.BufferGeometry(), material);
      line.frustumCulled = false;
      line.renderOrder = 0;
      scene.add(line);
      this.edges.push(line);
    }
  }
  update(
    data: SceneData,
    positions: Float32Array,
    mask: Uint8Array | null,
    selected: number | null,
    related: ReadonlySet<number>,
    hovered: number | null,
    edgeMask: Uint8Array | null = null,
  ): void {
    const b = buildBuffers(data, mask, selected, related, positions, edgeMask);
    this.buffers = b.nodes;
    this.segments = b.edges;
    this.positions = positions;
    this.hovered = hovered;
    this.selected = selected;
    this.visibleNodes = b.visibleNodes;
    this.visibleEdges = b.visibleEdges;
    this.nodeIndices = b.nodes.map((n) => n.indices);
    const matrix = new T.Matrix4(),
      position = new T.Vector3(),
      scale = new T.Vector3(),
      rotation = new T.Quaternion();
    b.nodes.forEach((buffer, k) => {
      const mesh = this.nodes[k]!;
      buffer.indices.forEach((index, j) => {
        position.fromArray(positions, index * 3);
        scale.setScalar(buffer.scale[j]! * (index === hovered ? 1.15 : 1));
        mesh.setMatrixAt(j, matrix.compose(position, rotation, scale));
        mesh.setColorAt(j, new T.Color(index === selected ? 0xc5dcec : NODE_COLORS[k]));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      // Three caches this bound for raycasting; matrices can change on every data tween.
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
      const alpha = mesh.geometry.getAttribute("nodeAlpha") as T.InstancedBufferAttribute;
      (alpha.array as Float32Array).set(buffer.alpha);
      alpha.needsUpdate = true;
    });
    b.edges.forEach((buffer, s) => {
      const line = this.edges[s]!;
      // Geometry replacement happens on data/style changes, never on camera-only frames.
      line.geometry.dispose();
      line.geometry = new T.BufferGeometry();
      line.geometry.setAttribute("position", new T.BufferAttribute(buffer.positions, 3));
      line.geometry.setAttribute("edgeColor", new T.BufferAttribute(buffer.colors, 3));
      line.geometry.setAttribute("edgeAlpha", new T.BufferAttribute(buffer.alpha, 1));
      line.geometry.setAttribute("lineDistance", new T.BufferAttribute(buffer.distance, 1));
      line.visible = buffer.indices.length > 0;
    });
  }
  /** Camera-only updates leave the edge geometry untouched. CPU scales also keep raycasts accurate. */
  updateProjection(camera: T.PerspectiveCamera, width: number, height: number): void {
    const matrix = new T.Matrix4(),
      point = new T.Vector3(),
      scale = new T.Vector3(),
      rotation = new T.Quaternion();
    const cameraPoint = new T.Vector3();
    const unit = (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2))) / height;
    let minX = 1,
      minY = 1,
      maxX = -1,
      maxY = -1;
    let largestRadiusPx = 0;
    const projection: { selection?: ProjectedSelection } = {};
    this.ring.visible = false;
    this.buffers.forEach((buffer, k) => {
      const mesh = this.nodes[k]!;
      buffer.indices.forEach((index, j) => {
        point.fromArray(this.positions, index * 3);
        cameraPoint.copy(point).applyMatrix4(camera.matrixWorldInverse);
        const minimum =
          ((k === 0 ? 2.3 : 3.5) * Math.max(0, -cameraPoint.z) * unit) / NODE_RADII[k]!;
        const depth = Math.max(0, -cameraPoint.z);
        const absoluteMinimum = ((k === 0 ? 1.5 : 2.3) * depth * unit) / NODE_RADII[k]!;
        const size =
          buffer.scale[j]! === 0
            ? 0
            : Math.max(
                absoluteMinimum,
                Math.max(1, minimum) * buffer.scale[j]! * (index === this.hovered ? 1.15 : 1),
              );
        scale.setScalar(size);
        mesh.setMatrixAt(j, matrix.compose(point, rotation, scale));
        if (size && cameraPoint.z < 0) {
          cameraPoint.copy(point).project(camera);
          minX = Math.min(minX, cameraPoint.x);
          maxX = Math.max(maxX, cameraPoint.x);
          minY = Math.min(minY, cameraPoint.y);
          maxY = Math.max(maxY, cameraPoint.y);
          if (
            index !== this.selected &&
            cameraPoint.z >= -1 &&
            cameraPoint.z <= 1 &&
            Math.abs(cameraPoint.x) <= 1 &&
            Math.abs(cameraPoint.y) <= 1
          )
            largestRadiusPx = Math.max(largestRadiusPx, (size * NODE_RADII[k]!) / (depth * unit));
        }
        if (index === this.selected && size) {
          projection.selection = { kind: k, instance: j, position: point.clone(), depth, size };
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    });
    // Prominence and kind must never make a neighbour visually outrank the selection.
    const chosen = projection.selection;
    if (chosen) {
      const size = Math.max(
        chosen.size,
        (largestRadiusPx * 1.15 * chosen.depth * unit) / NODE_RADII[chosen.kind]!,
      );
      this.nodes[chosen.kind]!.setMatrixAt(
        chosen.instance,
        matrix.compose(chosen.position, rotation, scale.setScalar(size)),
      );
      this.ring.visible = true;
      this.ring.position.copy(chosen.position);
      this.ring.quaternion.copy(camera.quaternion);
      this.ring.scale.setScalar(size * NODE_RADII[chosen.kind]!);
    }
    const area = Math.max(
      1,
      (Math.min(2, maxX - minX) * Math.min(2, maxY - minY) * width * height) / 4,
    );
    // Same edge count in a smaller projected footprint (or a smaller canvas) needs less ink.
    const density = Math.min(1, Math.sqrt(area / 600000));
    for (const edge of this.edges) edge.material.uniforms.density!.value = density;
  }
  dispose(): void {
    this.scene.remove(this.ring);
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    for (const object of [...this.nodes, ...this.edges]) {
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
      if (object instanceof T.InstancedMesh) object.dispose();
    }
    this.nodes.length = 0;
    this.edges.length = 0;
  }
}
