/**
 * Pose Studio Face Style: anime-style face shaping for the MakeHuman base mesh.
 *
 * The stage runs after the existing body/gender/age morphs. Bones and face
 * landmarks are always solved from the unstyled body morph, so the skeleton,
 * FK/IK and SAM 3D face retargeting never see the face edit; only the rendered
 * vertices move. Regions are vertex-index metadata derived once from the asset
 * (head skin weights + eye-landmark-relative smooth fields on the base mesh),
 * so they follow the same anatomy for every body shape. Every displacement is
 * linear in its slider and recomputed from the unstyled body morph, so
 * repeated edits never accumulate drift and all-zero values return the exact
 * original vertices.
 *
 * Pure module: no DOM or Three.js, shared by the morph worker and Node tests.
 */

export const FACE_STYLE_KEYS = Object.freeze([
    "face_softness",
    "face_jaw_narrowness",
    "face_nose_reduction",
    "face_eye_scale",
]);

export const FACE_STYLE_SLIDERS = Object.freeze([
    { key: "face_softness", label: "Face Softness" },
    { key: "face_jaw_narrowness", label: "Jaw Narrowness" },
    { key: "face_nose_reduction", label: "Nose Reduction" },
    { key: "face_eye_scale", label: "Eye Scale" },
]);

export const FACE_STYLE_PRESETS = Object.freeze({
    default: Object.freeze({ face_softness: 0, face_jaw_narrowness: 0, face_nose_reduction: 0, face_eye_scale: 0 }),
    soft: Object.freeze({ face_softness: 0.6, face_jaw_narrowness: 0.25, face_nose_reduction: 0.25, face_eye_scale: 0.15 }),
    anime_light: Object.freeze({ face_softness: 0.75, face_jaw_narrowness: 0.5, face_nose_reduction: 0.5, face_eye_scale: 0.45 }),
    anime_strong: Object.freeze({ face_softness: 1, face_jaw_narrowness: 0.85, face_nose_reduction: 0.85, face_eye_scale: 0.85 }),
});

export const FACE_STYLE_PRESET_OPTIONS = Object.freeze([
    { value: "default", label: "Default" },
    { value: "soft", label: "Soft" },
    { value: "anime_light", label: "Anime Light" },
    { value: "anime_strong", label: "Anime Strong" },
    { value: "custom", label: "Custom" },
]);

export const DEFAULT_FACE_STYLE_PARAMS = Object.freeze({
    face_style: "default",
    ...FACE_STYLE_PRESETS.default,
});

const clamp01 = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
};

/** Slider values with missing or invalid data treated as Default (0). */
export function faceStyleValues(params = {}) {
    const values = {};
    for (const key of FACE_STYLE_KEYS) values[key] = clamp01(params?.[key]);
    return values;
}

export function isDefaultFaceStyle(params = {}) {
    return FACE_STYLE_KEYS.every(key => clamp01(params?.[key]) === 0);
}

function matchesPreset(values, preset) {
    return FACE_STYLE_KEYS.every(key => Math.abs(values[key] - preset[key]) < 1e-6);
}

/**
 * Preset shown in the UI. An explicit "custom" stays custom; a named preset is
 * kept only while the values still match it; old data without `face_style`
 * resolves from its values (missing everything -> "default").
 */
export function resolveFaceStylePreset(params = {}) {
    const values = faceStyleValues(params);
    const stored = String(params?.face_style || "");
    if (stored === "custom") return "custom";
    if (FACE_STYLE_PRESETS[stored] && matchesPreset(values, FACE_STYLE_PRESETS[stored])) return stored;
    for (const [name, preset] of Object.entries(FACE_STYLE_PRESETS)) {
        if (matchesPreset(values, preset)) return name;
    }
    return "custom";
}

/** Write a preset into a mesh parameter object. Returns false for unknown names. */
export function applyFaceStylePreset(mesh, presetName) {
    const preset = FACE_STYLE_PRESETS[presetName];
    if (!mesh || !preset) return false;
    Object.assign(mesh, preset);
    mesh.face_style = presetName;
    return true;
}

/** Cache key for the unstyled body morph: every parameter except Face Style. */
export function bodyMorphSignature(params = {}) {
    const entries = Object.entries(params || {})
        .filter(([key]) => key !== "face_style" && !FACE_STYLE_KEYS.includes(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify(entries);
}

// ---------------------------------------------------------------------------
// Static rig: region weights as per-vertex metadata
// ---------------------------------------------------------------------------

// C2 "smootherstep": curvature stays continuous where a region fades out,
// so falloff borders do not show up as shading lines.
const smoothstep = (edge0, edge1, x) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * t * (t * (t * 6 - 15) + 10);
};

// Region shapes are expressed in eye-distance units (E) of a frame centred
// between the eyeballs: u = lateral, v = up, w = forward.
const EYE_CORE = { lateral: 0.5, medial: 0.3, up: 0.36, down: 0.34, depth: 0.45 };
// The eyeball and lids (rho < 0.85) scale rigidly. Outside, the slide keeps
// roughly the size it had at the lid edge instead of growing with distance and
// fades out over the orbit, so brows and temples are not dragged along.
const EYE_FALLOFF = [0.85, 2.2];

function centroid(vertices, indices) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const index of indices) {
        x += vertices[index * 3];
        y += vertices[index * 3 + 1];
        z += vertices[index * 3 + 2];
    }
    const count = Math.max(1, indices.length);
    return [x / count, y / count, z / count];
}

/** Eye-centred frame from the eyeball landmark groups. */
export function faceFrame(vertices, leftEye, rightEye) {
    const ex = leftEye[0] - rightEye[0];
    const ey = leftEye[1] - rightEye[1];
    const ez = leftEye[2] - rightEye[2];
    const eyeDistance = Math.hypot(ex, ey, ez) || 1;
    const xAxis = [ex / eyeDistance, ey / eyeDistance, ez / eyeDistance];
    // World up, orthogonalized against the eye axis.
    const dot = xAxis[1];
    let yAxis = [-dot * xAxis[0], 1 - dot * xAxis[1], -dot * xAxis[2]];
    const yLength = Math.hypot(...yAxis) || 1;
    yAxis = yAxis.map(value => value / yLength);
    const zAxis = [
        xAxis[1] * yAxis[2] - xAxis[2] * yAxis[1],
        xAxis[2] * yAxis[0] - xAxis[0] * yAxis[2],
        xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0],
    ];
    return {
        origin: [
            (leftEye[0] + rightEye[0]) * 0.5,
            (leftEye[1] + rightEye[1]) * 0.5,
            (leftEye[2] + rightEye[2]) * 0.5,
        ],
        eyeDistance,
        axes: [xAxis, yAxis, zAxis],
    };
}

function toLocal(frame, vertices, index, out) {
    const dx = vertices[index * 3] - frame.origin[0];
    const dy = vertices[index * 3 + 1] - frame.origin[1];
    const dz = vertices[index * 3 + 2] - frame.origin[2];
    const scale = 1 / frame.eyeDistance;
    for (let axis = 0; axis < 3; axis++) {
        const a = frame.axes[axis];
        out[axis] = (dx * a[0] + dy * a[1] + dz * a[2]) * scale;
    }
    return out;
}

function eyeDistance(u, v, w, side) {
    // side = +1 for the eye at u = +0.5, -1 for u = -0.5.
    const du = (u - side * 0.5) * side; // positive = lateral
    // Blend the half-axes smoothly so the distance has no crease through
    // the eye centre.
    const lateralBlend = smoothstep(-0.25, 0.25, du);
    const upBlend = smoothstep(-0.25, 0.25, v);
    const radiusU = EYE_CORE.medial + (EYE_CORE.lateral - EYE_CORE.medial) * lateralBlend;
    const radiusV = EYE_CORE.down + (EYE_CORE.up - EYE_CORE.down) * upBlend;
    return Math.hypot(du / radiusU, v / radiusV, w / EYE_CORE.depth);
}

function eyeWeight(u, v, w, side) {
    const rho = eyeDistance(u, v, w, side);
    const [inner, outer] = EYE_FALLOFF;
    if (rho <= inner) return 1;
    // 1 / (1 + t) with t ~ (rho - inner) / inner far out and zero slope at the
    // lid edge: the scaled offset keeps a constant length, with no crease.
    const excess = (rho - inner) / inner;
    return (1 - smoothstep(inner, outer, rho)) / (1 + excess * excess / (1 + excess));
}

function eyelidMask(u, v, w) {
    const rho = Math.min(eyeDistance(u, v, w, 1), eyeDistance(u, v, w, -1));
    return 1 - smoothstep(0.8, 1.35, rho);
}

function noseWeight(u, v, w) {
    // Lateral half width tapers from the alae (~0.3 E) to the bridge.
    const halfWidth = 0.13 + 0.21 * (1 - smoothstep(-0.45, -0.1, v));
    const lateral = 1 - smoothstep(halfWidth, halfWidth + 0.3, Math.abs(u));
    const vertical = smoothstep(-1.1, -0.72, v) * (1 - smoothstep(-0.22, 0.04, v));
    // Reaches into the nostrils so the cavity walls move with the alae.
    const depth = smoothstep(-0.3, 0.15, w);
    return lateral * vertical * depth;
}

function mouthWeight(u, v, w) {
    const rho = Math.hypot(u / 0.48, (v + 0.9) / 0.2, (w - 0.5) / 0.5);
    return 1 - smoothstep(1, 1.7, rho);
}

function jawWeight(u, v, w) {
    const below = smoothstep(-0.7, -1.4, v);
    const aboveNeck = 1 - smoothstep(-1.75, -2.2, v);
    // Peaks on the side of the jaw (the front-view silhouette) and fades
    // toward the ear and toward the mouth, so frontal cheeks stay full.
    const side = smoothstep(-1.85, -0.85, w) * (1 - smoothstep(-0.55, 0.45, w));
    return below * aboveNeck * side;
}

function softWeight(u, v, w, nose, eyelids, mouth) {
    const vertical = smoothstep(-2.1, -1.7, v) * (1 - smoothstep(0.8, 1.5, v));
    const front = smoothstep(-1.6, -0.9, w);
    return vertical * front * (1 - nose) * (1 - eyelids) * (1 - mouth);
}

const RIG_CACHE = new WeakMap();

/**
 * Static per-asset metadata. Weights are evaluated once on the asset's base
 * mesh and addressed by vertex index, so they keep marking the same anatomy
 * after any body morph.
 */
export function buildFaceStyleRig(data) {
    const cached = RIG_CACHE.get(data);
    if (cached) return cached;
    const vertexCount = data.vertexCount;
    const bodyCount = data.landmarkGroups?.body?.length || vertexCount;
    const leftEyeIndices = Array.from(data.landmarkGroups?.left_eye || []);
    const rightEyeIndices = Array.from(data.landmarkGroups?.right_eye || []);
    const headBone = data.bones.findIndex(bone => bone.name === "head");
    if (headBone < 0 || !leftEyeIndices.length || !rightEyeIndices.length) {
        const rig = { supported: false };
        RIG_CACHE.set(data, rig);
        return rig;
    }

    const rendered = new Uint8Array(vertexCount);
    for (const index of data.baseIndices) rendered[index] = 1;
    const eyeSide = new Int8Array(vertexCount);
    for (const index of leftEyeIndices) eyeSide[index] = 1;
    for (const index of rightEyeIndices) eyeSide[index] = -1;

    const domain = [];
    for (let index = 0; index < vertexCount; index++) {
        if (!rendered[index]) continue;
        let headWeight = 0;
        for (let slot = 0; slot < 4; slot++) {
            if (data.skinIndices[index * 4 + slot] === headBone) headWeight += data.skinWeights[index * 4 + slot];
        }
        if (headWeight > 1e-4) domain.push(index);
    }

    const base = data.baseVertices;
    const frame = faceFrame(base, centroid(base, leftEyeIndices), centroid(base, rightEyeIndices));
    const count = domain.length;
    const soft = new Float32Array(count);
    const jaw = new Float32Array(count);
    const nose = new Float32Array(count);
    const eyeLeft = new Float32Array(count);
    const eyeRight = new Float32Array(count);
    const eyeCore = new Float32Array(count);
    const isBodySurface = new Uint8Array(count);
    const local = [0, 0, 0];
    const slotOf = new Int32Array(vertexCount).fill(-1);
    for (let slot = 0; slot < count; slot++) {
        const index = domain[slot];
        slotOf[index] = slot;
        toLocal(frame, base, index, local);
        const [u, v, w] = local;
        const side = eyeSide[index];
        const helper = index >= bodyCount;
        let left = side === 1 ? 1 : side === -1 ? 0 : eyeWeight(u, v, w, 1);
        let right = side === -1 ? 1 : side === 1 ? 0 : eyeWeight(u, v, w, -1);
        if (!side && helper) {
            // Teeth and tongue sit far below the orbits.
            left = 0;
            right = 0;
        }
        const total = left + right;
        if (total > 1) {
            left /= total;
            right /= total;
        }
        eyeLeft[slot] = left;
        eyeRight[slot] = right;
        eyeCore[slot] = side ? 1 : eyelidMask(u, v, w);
        if (side) continue; // Eyeballs follow their eye transform only.
        const noseValue = helper ? 0 : noseWeight(u, v, w);
        const mouthValue = mouthWeight(u, v, w);
        nose[slot] = noseValue;
        jaw[slot] = jawWeight(u, v, w);
        if (!helper) {
            isBodySurface[slot] = 1;
            soft[slot] = softWeight(u, v, w, noseValue, eyeCore[slot], mouthValue);
        }
    }

    // Body-surface triangles touching the domain, for normals and smoothing.
    const triangles = [];
    const guardTriangles = [];
    const neighborSets = new Map();
    const indices = data.baseIndices;
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t];
        const b = indices[t + 1];
        const c = indices[t + 2];
        if (slotOf[a] < 0 && slotOf[b] < 0 && slotOf[c] < 0) continue;
        guardTriangles.push(a, b, c);
        if (a >= bodyCount || b >= bodyCount || c >= bodyCount) continue;
        triangles.push(a, b, c);
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            for (const [from, to] of [[p, q], [q, p]]) {
                if (slotOf[from] < 0) continue;
                let set = neighborSets.get(from);
                if (!set) neighborSets.set(from, set = new Set());
                set.add(to);
            }
        }
    }
    const neighborOffsets = new Uint32Array(count + 1);
    const neighborList = [];
    for (let slot = 0; slot < count; slot++) {
        neighborOffsets[slot] = neighborList.length;
        const set = neighborSets.get(domain[slot]);
        if (set && isBodySurface[slot]) for (const neighbor of [...set].sort((l, r) => l - r)) neighborList.push(neighbor);
    }
    neighborOffsets[count] = neighborList.length;

    const rig = {
        supported: true,
        domain: Uint32Array.from(domain),
        slotOf,
        soft,
        jaw,
        nose,
        eyeLeft,
        eyeRight,
        eyeCore,
        isBodySurface,
        triangles: Uint32Array.from(triangles),
        guardTriangles: Uint32Array.from(guardTriangles),
        neighborOffsets,
        neighbors: Uint32Array.from(neighborList),
        leftEyeIndices: Uint32Array.from(leftEyeIndices),
        rightEyeIndices: Uint32Array.from(rightEyeIndices),
    };
    RIG_CACHE.set(data, rig);
    return rig;
}

// ---------------------------------------------------------------------------
// Per-body-shape displacement basis
// ---------------------------------------------------------------------------

const SOFT_ITERATIONS = 100;
const SOFT_LAMBDA = 0.5;
const SOFT_MU = -0.53;
const SOFT_GAIN = 1.4;
const FIELD_DIFFUSION = 8;
const NOSE_DIFFUSION = 3;
const JAW_NARROWING = 0.25;
const NOSE_SCALE = [0.3, 0.22, 0.5];
const NOSE_PIVOT = [0, 0.07, -0.4]; // relative to the nose tip, in E units
const EYE_SCALE = [0.2, 0.3, 0];

function vertexNormals(rig, vertices) {
    const normals = new Float32Array(rig.domain.length * 3);
    const tris = rig.triangles;
    for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t];
        const b = tris[t + 1];
        const c = tris[t + 2];
        const ux = vertices[b * 3] - vertices[a * 3];
        const uy = vertices[b * 3 + 1] - vertices[a * 3 + 1];
        const uz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
        const vx = vertices[c * 3] - vertices[a * 3];
        const vy = vertices[c * 3 + 1] - vertices[a * 3 + 1];
        const vz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const index of [a, b, c]) {
            const slot = rig.slotOf[index];
            if (slot < 0) continue;
            normals[slot * 3] += nx;
            normals[slot * 3 + 1] += ny;
            normals[slot * 3 + 2] += nz;
        }
    }
    for (let slot = 0; slot < rig.domain.length; slot++) {
        const length = Math.hypot(normals[slot * 3], normals[slot * 3 + 1], normals[slot * 3 + 2]) || 1;
        normals[slot * 3] /= length;
        normals[slot * 3 + 1] /= length;
        normals[slot * 3 + 2] /= length;
    }
    return normals;
}

/** Taubin (lambda/mu) low-pass of the face surface: bony relief without shrinkage. */
function smoothedSurface(rig, vertices) {
    const count = rig.domain.length;
    let current = new Float32Array(vertices);
    let next = new Float32Array(vertices);
    for (let iteration = 0; iteration < SOFT_ITERATIONS * 2; iteration++) {
        const factor = iteration % 2 === 0 ? SOFT_LAMBDA : SOFT_MU;
        for (let slot = 0; slot < count; slot++) {
            const index = rig.domain[slot];
            const start = rig.neighborOffsets[slot];
            const end = rig.neighborOffsets[slot + 1];
            if (end <= start) continue;
            let x = 0;
            let y = 0;
            let z = 0;
            for (let k = start; k < end; k++) {
                const neighbor = rig.neighbors[k];
                x += current[neighbor * 3];
                y += current[neighbor * 3 + 1];
                z += current[neighbor * 3 + 2];
            }
            const inverse = 1 / (end - start);
            for (let axis = 0; axis < 3; axis++) {
                const value = current[index * 3 + axis];
                const mean = (axis === 0 ? x : axis === 1 ? y : z) * inverse;
                next[index * 3 + axis] = value + factor * (mean - value);
            }
        }
        // Vertices outside the domain (and helpers) are never written, so
        // both buffers keep their original positions as fixed boundaries.
        const swap = current;
        current = next;
        next = swap;
    }
    return current;
}

/**
 * Relax a displacement field over the surface. Region weights are smooth in
 * space, but diffusing the result removes residual creases where a falloff
 * crosses dense geometry. Vertices outside the domain act as zero boundary.
 */
function diffuseField(rig, field, iterations) {
    const count = rig.domain.length;
    let current = field;
    let next = new Float32Array(field);
    for (let iteration = 0; iteration < iterations; iteration++) {
        for (let slot = 0; slot < count; slot++) {
            const start = rig.neighborOffsets[slot];
            const end = rig.neighborOffsets[slot + 1];
            if (end <= start) continue;
            let x = 0;
            let y = 0;
            let z = 0;
            for (let k = start; k < end; k++) {
                const neighborSlot = rig.slotOf[rig.neighbors[k]];
                if (neighborSlot < 0) continue;
                x += current[neighborSlot * 3];
                y += current[neighborSlot * 3 + 1];
                z += current[neighborSlot * 3 + 2];
            }
            const inverse = 0.5 / (end - start);
            next[slot * 3] = current[slot * 3] * 0.5 + x * inverse;
            next[slot * 3 + 1] = current[slot * 3 + 1] * 0.5 + y * inverse;
            next[slot * 3 + 2] = current[slot * 3 + 2] * 0.5 + z * inverse;
        }
        const swap = current;
        current = next;
        next = swap;
    }
    if (current !== field) field.set(current);
    return field;
}

/**
 * Displacement fields for one unstyled body morph. Each field is the full
 * slider (value 1) displacement of every domain vertex.
 */
export function buildFaceStyleBasis(data, vertices, landmarks) {
    const rig = buildFaceStyleRig(data);
    if (!rig.supported || !landmarks?.left_eye || !landmarks?.right_eye || !landmarks?.nose) return null;
    const frame = faceFrame(vertices, landmarks.left_eye, landmarks.right_eye);
    const E = frame.eyeDistance;
    const [X, Y, Z] = frame.axes;
    const count = rig.domain.length;
    const fields = {
        face_softness: new Float32Array(count * 3),
        face_jaw_narrowness: new Float32Array(count * 3),
        face_nose_reduction: new Float32Array(count * 3),
        face_eye_scale: new Float32Array(count * 3),
    };
    const fromLocal = (out, slot, lu, lv, lw) => {
        out[slot * 3] += X[0] * lu + Y[0] * lv + Z[0] * lw;
        out[slot * 3 + 1] += X[1] * lu + Y[1] * lv + Z[1] * lw;
        out[slot * 3 + 2] += X[2] * lu + Y[2] * lv + Z[2] * lw;
    };

    const normals = vertexNormals(rig, vertices);
    const smoothed = smoothedSurface(rig, vertices);
    const noseTipLocal = toLocal(frame, [landmarks.nose[0], landmarks.nose[1], landmarks.nose[2]], 0, [0, 0, 0]);
    const pivot = [0, noseTipLocal[1] + NOSE_PIVOT[1], noseTipLocal[2] + NOSE_PIVOT[2]];
    const leftCenter = toLocal(frame, landmarks.left_eye, 0, [0, 0, 0]);
    const rightCenter = toLocal(frame, landmarks.right_eye, 0, [0, 0, 0]);
    const local = [0, 0, 0];

    for (let slot = 0; slot < count; slot++) {
        const index = rig.domain[slot];
        toLocal(frame, vertices, index, local);
        const [u, v, w] = local;

        const softWeightValue = rig.soft[slot];
        if (softWeightValue > 0) {
            const dx = smoothed[index * 3] - vertices[index * 3];
            const dy = smoothed[index * 3 + 1] - vertices[index * 3 + 1];
            const dz = smoothed[index * 3 + 2] - vertices[index * 3 + 2];
            const nx = normals[slot * 3];
            const ny = normals[slot * 3 + 1];
            const nz = normals[slot * 3 + 2];
            const along = (dx * nx + dy * ny + dz * nz) * softWeightValue * SOFT_GAIN;
            fields.face_softness[slot * 3] = nx * along;
            fields.face_softness[slot * 3 + 1] = ny * along;
            fields.face_softness[slot * 3 + 2] = nz * along;
        }

        const jawValue = rig.jaw[slot];
        if (jawValue > 0) fromLocal(fields.face_jaw_narrowness, slot, -JAW_NARROWING * jawValue * u * E, 0, 0);

        const noseValue = rig.nose[slot];
        if (noseValue > 0) {
            // Projection shrinks toward the face plane through the alar base;
            // the nasal cavity behind that plane is not pulled forward.
            // The alar grooves sink only half as far as the tip so the cheek
            // skin never slides in front of the nostril walls.
            const front = smoothstep(pivot[2] - 0.3, pivot[2], w)
                * (1 - 0.5 * smoothstep(0, 0.5, Math.abs(u)));
            // Only the nose shortens; upper-lip skin below the nostrils must
            // not slide up over the gums that sit right behind it.
            const above = smoothstep(pivot[1] - 0.32, pivot[1] - 0.12, v);
            fromLocal(
                fields.face_nose_reduction,
                slot,
                -NOSE_SCALE[0] * noseValue * (u - pivot[0]) * E,
                -NOSE_SCALE[1] * noseValue * above * (v - pivot[1]) * E,
                -NOSE_SCALE[2] * noseValue * front * (w - pivot[2]) * E,
            );
        }

        for (const [weight, center] of [[rig.eyeLeft[slot], leftCenter], [rig.eyeRight[slot], rightCenter]]) {
            if (weight <= 0) continue;
            fromLocal(
                fields.face_eye_scale,
                slot,
                EYE_SCALE[0] * weight * (u - center[0]) * E,
                EYE_SCALE[1] * weight * (v - center[1]) * E,
                EYE_SCALE[2] * weight * (w - center[2]) * E,
            );
        }
        if (rig.isBodySurface[slot] && rig.eyeCore[slot] < 1) {
            // Lids and eyeballs scale rigidly; the surrounding orbit skin only
            // slides along the surface, so brows, temples and cheeks keep
            // their shape instead of bulging into a ring.
            const eye = fields.face_eye_scale;
            const nx = normals[slot * 3];
            const ny = normals[slot * 3 + 1];
            const nz = normals[slot * 3 + 2];
            const along = (eye[slot * 3] * nx + eye[slot * 3 + 1] * ny + eye[slot * 3 + 2] * nz)
                * (1 - rig.eyeCore[slot]);
            eye[slot * 3] -= nx * along;
            eye[slot * 3 + 1] -= ny * along;
            eye[slot * 3 + 2] -= nz * along;
        }
    }
    diffuseField(rig, fields.face_softness, FIELD_DIFFUSION);
    diffuseField(rig, fields.face_jaw_narrowness, FIELD_DIFFUSION);
    diffuseField(rig, fields.face_nose_reduction, NOSE_DIFFUSION);
    const quadratic = {
        face_eye_scale: surfaceFollowTerm(rig, vertices, normals, fields.face_eye_scale),
    };
    return { domain: rig.domain, fields, quadratic };
}

/**
 * Second-order term that keeps skin sliding around the orbit on the original
 * surface. A tangential move of length t over a surface with curvature k
 * leaves the surface by about k t^2 / 2, which reads as a ridge on the curved
 * temples. The moved point (at slider 1) is snapped to the tangent plane of
 * the nearest original vertex; the offset scales with the square of the
 * slider, like the error it cancels.
 */
function surfaceFollowTerm(rig, vertices, normals, field) {
    const count = rig.domain.length;
    const out = new Float32Array(count * 3);
    const moved = [0, 0, 0];
    const distanceTo = (index) => Math.hypot(
        vertices[index * 3] - moved[0],
        vertices[index * 3 + 1] - moved[1],
        vertices[index * 3 + 2] - moved[2],
    );
    for (let slot = 0; slot < count; slot++) {
        const slide = rig.isBodySurface[slot] ? 1 - rig.eyeCore[slot] : 0;
        if (slide <= 0) continue;
        if (!field[slot * 3] && !field[slot * 3 + 1] && !field[slot * 3 + 2]) continue;
        const index = rig.domain[slot];
        for (let axis = 0; axis < 3; axis++) moved[axis] = vertices[index * 3 + axis] + field[slot * 3 + axis];
        // Greedy walk over body-surface neighbours to the nearest vertex.
        let nearestSlot = slot;
        let nearest = distanceTo(index);
        for (let step = 0; step < 32; step++) {
            let improved = false;
            for (let k = rig.neighborOffsets[nearestSlot]; k < rig.neighborOffsets[nearestSlot + 1]; k++) {
                const neighbor = rig.neighbors[k];
                const neighborSlot = rig.slotOf[neighbor];
                if (neighborSlot < 0 || !rig.isBodySurface[neighborSlot]) continue;
                const distance = distanceTo(neighbor);
                if (distance < nearest) {
                    nearest = distance;
                    nearestSlot = neighborSlot;
                    improved = true;
                }
            }
            if (!improved) break;
        }
        const anchor = rig.domain[nearestSlot];
        const nx = normals[nearestSlot * 3];
        const ny = normals[nearestSlot * 3 + 1];
        const nz = normals[nearestSlot * 3 + 2];
        const height = (moved[0] - vertices[anchor * 3]) * nx
            + (moved[1] - vertices[anchor * 3 + 1]) * ny
            + (moved[2] - vertices[anchor * 3 + 2]) * nz;
        out[slot * 3] = -nx * height * slide;
        out[slot * 3 + 1] = -ny * height * slide;
        out[slot * 3 + 2] = -nz * height * slide;
    }
    return out;
}

/** Add the weighted fields to a copy-owned vertex buffer in place. */
export function applyFaceStyleBasis(target, basis, params = {}) {
    if (!basis) return target;
    const values = faceStyleValues(params);
    const active = FACE_STYLE_KEYS.filter(key => values[key] > 0);
    if (!active.length) return target;
    const domain = basis.domain;
    for (const key of active) {
        const amount = values[key];
        const field = basis.fields[key];
        const quadratic = basis.quadratic?.[key];
        const squared = amount * amount;
        for (let slot = 0; slot < domain.length; slot++) {
            const offset = domain[slot] * 3;
            target[offset] += field[slot * 3] * amount;
            target[offset + 1] += field[slot * 3 + 1] * amount;
            target[offset + 2] += field[slot * 3 + 2] * amount;
            if (!quadratic) continue;
            target[offset] += quadratic[slot * 3] * squared;
            target[offset + 1] += quadratic[slot * 3 + 1] * squared;
            target[offset + 2] += quadratic[slot * 3 + 2] * squared;
        }
    }
    return target;
}

// A guarded triangle may turn sideways but never face backwards, and keeps
// at least 3 % of its area.
const FOLD_PASSES = 16;
const FOLD_MIN_COSINE = 0;
const FOLD_MIN_AREA = 0.03;
const FOLD_SPREAD = 3;

/**
 * Safety net for slivers in tight folds (alar crease, mouth cavity): fields
 * that are individually smooth can still flip or collapse a tiny triangle
 * when combined or on extreme body shapes. Instead of editing single vertices
 * (which only moves the sliver next door), a per-vertex attenuation of the
 * whole style displacement is lowered around offending triangles and spread
 * over a few rings, so the style fades out smoothly at that spot. Attenuation
 * only decreases and zero means the unstyled, valid mesh, so it terminates.
 */
function relaxFoldedTriangles(rig, source, target) {
    const tris = rig.guardTriangles;
    const domain = rig.domain;
    const displacement = new Float32Array(domain.length * 3);
    for (let slot = 0; slot < domain.length; slot++) {
        for (let axis = 0; axis < 3; axis++) {
            const offset = domain[slot] * 3 + axis;
            displacement[slot * 3 + axis] = target[offset] - source[offset];
        }
    }
    const normal = (vertices, a, b, c, out) => {
        const ux = vertices[b * 3] - vertices[a * 3];
        const uy = vertices[b * 3 + 1] - vertices[a * 3 + 1];
        const uz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
        const vx = vertices[c * 3] - vertices[a * 3];
        const vy = vertices[c * 3 + 1] - vertices[a * 3 + 1];
        const vz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
        out[0] = uy * vz - uz * vy;
        out[1] = uz * vx - ux * vz;
        out[2] = ux * vy - uy * vx;
        return out;
    };
    const before = [0, 0, 0];
    const after = [0, 0, 0];
    let attenuation = null;
    for (let pass = 0; pass < FOLD_PASSES; pass++) {
        const flagged = new Set();
        for (let t = 0; t < tris.length; t += 3) {
            const a = tris[t];
            const b = tris[t + 1];
            const c = tris[t + 2];
            normal(source, a, b, c, before);
            normal(target, a, b, c, after);
            const areaBefore = Math.hypot(before[0], before[1], before[2]);
            if (areaBefore < 1e-12) continue;
            const areaAfter = Math.hypot(after[0], after[1], after[2]);
            const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
            if (dot >= FOLD_MIN_COSINE * areaBefore * areaAfter && areaAfter >= FOLD_MIN_AREA * areaBefore) continue;
            for (const index of [a, b, c]) if (rig.slotOf[index] >= 0) flagged.add(rig.slotOf[index]);
        }
        if (!flagged.size) break;
        if (!attenuation) attenuation = new Float32Array(domain.length).fill(1);
        for (const slot of flagged) attenuation[slot] *= 0.5;
        // Spread the reduction: a vertex never stays far above its neighbours.
        for (let ring = 0; ring < FOLD_SPREAD; ring++) {
            const next = attenuation.slice();
            for (let slot = 0; slot < domain.length; slot++) {
                const start = rig.neighborOffsets[slot];
                const end = rig.neighborOffsets[slot + 1];
                if (end <= start) continue;
                let sum = attenuation[slot];
                for (let k = start; k < end; k++) {
                    const neighborSlot = rig.slotOf[rig.neighbors[k]];
                    sum += neighborSlot >= 0 ? attenuation[neighborSlot] : 1;
                }
                next[slot] = Math.min(attenuation[slot], sum / (end - start + 1));
            }
            attenuation = next;
        }
        for (let slot = 0; slot < domain.length; slot++) {
            for (let axis = 0; axis < 3; axis++) {
                const offset = domain[slot] * 3 + axis;
                target[offset] = source[offset] + displacement[slot * 3 + axis] * attenuation[slot];
            }
        }
    }
    return target;
}

/**
 * Final morph stage. `body` is an unstyled solve; it is never mutated, so it
 * can be cached and reused while only Face Style sliders change. `cache` (an
 * optional object tied to that body solve) stores the lazily built basis.
 */
export function applyFaceStyleToMorph(data, body, params = {}, cache = null) {
    const vertices = new Float32Array(body.vertices);
    const result = {
        vertices,
        bonePositions: new Float32Array(body.bonePositions),
        landmarks: body.landmarks,
        landmarkIndices: body.landmarkIndices,
        includeGenitals: body.includeGenitals,
    };
    if (isDefaultFaceStyle(params)) return result;
    let basis = cache?.faceStyleBasis;
    if (basis === undefined) {
        basis = buildFaceStyleBasis(data, body.vertices, body.landmarks);
        if (cache) cache.faceStyleBasis = basis;
    }
    if (!basis) return result;
    applyFaceStyleBasis(vertices, basis, params);
    relaxFoldedTriangles(buildFaceStyleRig(data), body.vertices, vertices);
    // Landmarks describe the rig, not the styled surface: consumers fall back
    // to the unstyled rest landmarks carried by the head bone.
    result.landmarkIndices = {};
    return result;
}
