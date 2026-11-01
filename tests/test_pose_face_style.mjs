import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
    DEFAULT_FACE_STYLE_PARAMS,
    FACE_STYLE_KEYS,
    FACE_STYLE_PRESETS,
    applyFaceStylePreset,
    applyFaceStyleToMorph,
    bodyMorphSignature,
    buildFaceStyleRig,
    faceFrame,
    isDefaultFaceStyle,
    resolveFaceStylePreset,
} from "../web/pose_studio/face_style.mjs";
import { parseMorphPack, solveBodyMorph, solveMorph } from "../web/pose_studio/morph_runtime.mjs";
import {
    createPoseStudioCharacter,
    normalizePoseStudioCharacters,
    serializePoseStudioCharacter,
} from "../web/pose_studio/characters.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = path.resolve(TEST_DIR, "../web/pose_studio/assets/pose_studio_makehuman.v2.bin.gz");
const raw = gunzipSync(fs.readFileSync(ASSET_PATH));
const data = parseMorphPack(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const rig = buildFaceStyleRig(data);
const ALL_MAX = Object.fromEntries(FACE_STYLE_KEYS.map(key => [key, 1]));
const BODIES = {
    neutral: {},
    male: { gender: 1, age: 45, muscle: 0.8, weight: 0.4 },
    child: { gender: 0.2, age: 8, weight: 0.6 },
    elder: { gender: 0, age: 80, weight: 0.8, height: 0.2 },
};

function headWeight(index) {
    const head = data.bones.findIndex(bone => bone.name === "head");
    let weight = 0;
    for (let slot = 0; slot < 4; slot++) {
        if (data.skinIndices[index * 4 + slot] === head) weight += data.skinWeights[index * 4 + slot];
    }
    return weight;
}

function triangleNormal(vertices, a, b, c) {
    const ux = vertices[b * 3] - vertices[a * 3];
    const uy = vertices[b * 3 + 1] - vertices[a * 3 + 1];
    const uz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
    const vx = vertices[c * 3] - vertices[a * 3];
    const vy = vertices[c * 3 + 1] - vertices[a * 3 + 1];
    const vz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function triangleStats(source, styled) {
    let flipped = 0;
    let degenerate = 0;
    let degenerateBefore = 0;
    const indices = data.baseIndices;
    for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
        const before = triangleNormal(source, a, b, c);
        const after = triangleNormal(styled, a, b, c);
        const areaBefore = Math.hypot(...before);
        const areaAfter = Math.hypot(...after);
        if (areaBefore < 1e-10) degenerateBefore++;
        if (areaAfter < 1e-10) degenerate++;
        if (areaBefore < 1e-10 || areaAfter < 1e-10) continue;
        const dot = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (areaBefore * areaAfter);
        if (dot < 0) flipped++;
    }
    return { flipped, degenerate, degenerateBefore };
}

function mirrorMap(vertices) {
    const key = (x, y, z) => `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
    const lookup = new Map();
    for (let index = 0; index < data.vertexCount; index++) {
        lookup.set(key(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]), index);
    }
    const pairs = [];
    for (const index of rig.domain) {
        const mirror = lookup.get(key(-vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]));
        if (mirror !== undefined) pairs.push([index, mirror]);
    }
    return pairs;
}

function localDelta(body, styled, indices) {
    const frame = faceFrame(body.vertices, body.landmarks.left_eye, body.landmarks.right_eye);
    let sum = [0, 0, 0];
    for (const index of indices) {
        for (let axis = 0; axis < 3; axis++) sum[axis] += styled[index * 3 + axis] - body.vertices[index * 3 + axis];
    }
    sum = sum.map(value => value / indices.length / frame.eyeDistance);
    return sum;
}

function extent(vertices, indices, axis) {
    let min = Infinity;
    let max = -Infinity;
    for (const index of indices) {
        min = Math.min(min, vertices[index * 3 + axis]);
        max = Math.max(max, vertices[index * 3 + axis]);
    }
    return max - min;
}

test("Face Style rig is metadata over the existing head topology", () => {
    assert.equal(rig.supported, true);
    assert.ok(rig.domain.length > 4000 && rig.domain.length < 6000);
    for (const index of rig.domain) assert.ok(headWeight(index) > 0, `vertex ${index} is outside the head`);
    // Independent eyeballs exist and are rigidly attached to the head bone.
    assert.equal(rig.leftEyeIndices.length, 72);
    assert.equal(rig.rightEyeIndices.length, 72);
    for (const index of [...rig.leftEyeIndices, ...rig.rightEyeIndices]) {
        assert.ok(Math.abs(headWeight(index) - 1) < 1e-6);
    }
});

test("Default and missing Face Style values return the exact unstyled morph", () => {
    for (const params of Object.values(BODIES)) {
        const body = solveBodyMorph(data, params);
        for (const face of [{}, DEFAULT_FACE_STYLE_PARAMS, { face_style: "custom" }, { face_softness: "bad" }]) {
            const result = solveMorph(data, { ...params, ...face });
            assert.deepEqual(result.vertices, body.vertices);
            assert.deepEqual(result.bonePositions, body.bonePositions);
            assert.deepEqual(result.landmarks, body.landmarks);
            assert.deepEqual(result.landmarkIndices, body.landmarkIndices);
        }
    }
});

test("Face Style never moves bones, landmarks, or vertices outside the head", () => {
    const outside = new Uint8Array(data.vertexCount).fill(1);
    for (const index of rig.domain) outside[index] = 0;
    for (const params of Object.values(BODIES)) {
        const body = solveBodyMorph(data, params);
        for (const face of [ALL_MAX, FACE_STYLE_PRESETS.anime_strong, { face_eye_scale: 1 }]) {
            const result = solveMorph(data, { ...params, ...face });
            assert.deepEqual(result.bonePositions, body.bonePositions);
            assert.deepEqual(result.landmarks, body.landmarks);
            // Consumers fall back to rest landmarks carried by the head bone.
            assert.deepEqual(result.landmarkIndices, {});
            assert.ok(result.vertices.every(Number.isFinite));
            for (let index = 0; index < data.vertexCount; index++) {
                if (!outside[index]) continue;
                for (let axis = 0; axis < 3; axis++) {
                    assert.equal(result.vertices[index * 3 + axis], body.vertices[index * 3 + axis]);
                }
            }
        }
    }
});

test("landmark fallback is exact: eye and nose landmark vertices are fully head-skinned", () => {
    const body = solveBodyMorph(data, {});
    for (const indices of Object.values(body.landmarkIndices)) {
        for (const index of indices) assert.ok(Math.abs(headWeight(index) - 1) < 1e-6, `landmark vertex ${index}`);
    }
});

test("each slider changes its own region measurably", () => {
    const body = solveBodyMorph(data, {});
    const frame = faceFrame(body.vertices, body.landmarks.left_eye, body.landmarks.right_eye);
    const style = params => solveMorph(data, params).vertices;

    // Eye Scale: the independent eyeballs and lids grow around a fixed centre.
    const eyes = style({ face_eye_scale: 1 });
    for (const indices of [rig.leftEyeIndices, rig.rightEyeIndices]) {
        assert.ok(extent(eyes, indices, 1) / extent(body.vertices, indices, 1) > 1.25);
        assert.ok(extent(eyes, indices, 0) / extent(body.vertices, indices, 0) > 1.15);
        const shift = localDelta(body, eyes, indices);
        assert.ok(Math.hypot(...shift) < 1e-6, "eye centre moved");
    }

    // Nose Reduction: the tip loses projection and the nose gets narrower.
    const nose = style({ face_nose_reduction: 1 });
    const tip = body.landmarkIndices.nose;
    assert.ok(localDelta(body, nose, tip)[2] < -0.12);
    const alae = rig.domain.filter(index => {
        const x = (body.vertices[index * 3] - frame.origin[0]) / frame.eyeDistance;
        const y = (body.vertices[index * 3 + 1] - frame.origin[1]) / frame.eyeDistance;
        const z = (body.vertices[index * 3 + 2] - frame.origin[2]) / frame.eyeDistance;
        return Math.abs(y + 0.6) < 0.08 && z > 0.35 && Math.abs(x) > 0.15 && Math.abs(x) < 0.35;
    });
    assert.ok(alae.length > 4);
    assert.ok(extent(nose, alae, 0) < extent(body.vertices, alae, 0) * 0.85);

    // Jaw Narrowness: the jaw sides move toward the midline, the cranium does not.
    const jaw = style({ face_jaw_narrowness: 1 });
    const local = index => [0, 1, 2].map(axis => (
        (body.vertices[index * 3 + axis] - frame.origin[axis]) / frame.eyeDistance
    ));
    const jawSides = rig.domain.filter(index => {
        const [x, y, z] = local(index);
        return y < -1.0 && y > -1.5 && z < -0.4 && z > -1.0 && Math.abs(x) > 0.7;
    });
    const cranium = rig.domain.filter(index => local(index)[1] > 1.4);
    assert.ok(jawSides.length > 8);
    for (const index of jawSides) {
        assert.ok(Math.abs(jaw[index * 3]) < Math.abs(body.vertices[index * 3]) - 0.01);
    }
    for (const index of cranium) assert.equal(jaw[index * 3], body.vertices[index * 3]);

    // Face Softness: bony relief changes on the cheeks, while eyeballs and teeth stay.
    const soft = style({ face_softness: 1 });
    let moved = 0;
    for (const index of rig.domain) {
        const d = Math.hypot(...[0, 1, 2].map(axis => soft[index * 3 + axis] - body.vertices[index * 3 + axis]));
        if (d > 0.005) moved++;
    }
    assert.ok(moved > 200);
    for (const index of [...rig.leftEyeIndices, ...rig.rightEyeIndices]) {
        assert.equal(soft[index * 3], body.vertices[index * 3]);
    }
});

test("symmetric bodies stay symmetric after styling", () => {
    for (const params of [BODIES.neutral, BODIES.male]) {
        const body = solveBodyMorph(data, params);
        const pairs = mirrorMap(body.vertices);
        assert.ok(pairs.length > rig.domain.length * 0.99);
        const styled = solveMorph(data, { ...params, ...ALL_MAX }).vertices;
        let worst = 0;
        for (const [index, mirror] of pairs) {
            worst = Math.max(
                worst,
                Math.abs(styled[index * 3] + styled[mirror * 3]),
                Math.abs(styled[index * 3 + 1] - styled[mirror * 3 + 1]),
                Math.abs(styled[index * 3 + 2] - styled[mirror * 3 + 2]),
            );
        }
        assert.ok(worst < 2e-3, `asymmetry ${worst}`);
    }
});

test("styled meshes have no flipped or collapsed faces and no seams at the neck", () => {
    for (const params of Object.values(BODIES)) {
        const body = solveBodyMorph(data, params);
        const frame = faceFrame(body.vertices, body.landmarks.left_eye, body.landmarks.right_eye);
        const up = index => [0, 1, 2].reduce((sum, axis) => (
            sum + (body.vertices[index * 3 + axis] - frame.origin[axis]) * frame.axes[1][axis]
        ), 0) / frame.eyeDistance;
        for (const face of [ALL_MAX, FACE_STYLE_PRESETS.anime_strong, FACE_STYLE_PRESETS.soft]) {
            const styled = solveMorph(data, { ...params, ...face }).vertices;
            const stats = triangleStats(body.vertices, styled);
            assert.equal(stats.flipped, 0);
            assert.equal(stats.degenerate, stats.degenerateBefore);
            // Displacement varies smoothly along every edge. Where the head
            // region fades out into the neck it must be far below the edge
            // length (no seam); inside tight folds such as the alar crease the
            // fold guard keeps it below a tear.
            let worst = 0;
            let worstNeck = 0;
            const indices = data.baseIndices;
            for (let t = 0; t < indices.length; t += 3) {
                for (const [a, b] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]]]) {
                    const edge = Math.hypot(...[0, 1, 2].map(axis => body.vertices[a * 3 + axis] - body.vertices[b * 3 + axis]));
                    if (edge < 1e-6) continue;
                    const step = Math.hypot(...[0, 1, 2].map(axis => (
                        (styled[a * 3 + axis] - body.vertices[a * 3 + axis])
                        - (styled[b * 3 + axis] - body.vertices[b * 3 + axis])
                    ))) / edge;
                    worst = Math.max(worst, step);
                    if (up(a) < -1.6 || up(b) < -1.6) worstNeck = Math.max(worstNeck, step);
                }
            }
            assert.ok(worstNeck < 0.5, `neck displacement step ratio ${worstNeck}`);
            assert.ok(worst < 1.25, `displacement step ratio ${worst}`);
        }
    }
});

test("repeated and cached updates never drift", () => {
    const body = solveBodyMorph(data, BODIES.male);
    const target = { ...BODIES.male, ...FACE_STYLE_PRESETS.anime_light };
    const fresh = solveMorph(data, target).vertices;
    const cache = {};
    for (let step = 0; step < 40; step++) {
        const value = (step % 7) / 6;
        applyFaceStyleToMorph(data, body, { ...BODIES.male, face_softness: value, face_eye_scale: 1 - value }, cache);
    }
    const cached = applyFaceStyleToMorph(data, body, target, cache).vertices;
    assert.deepEqual(cached, fresh);
    // The cached unstyled body is never mutated.
    assert.deepEqual(body.vertices, solveBodyMorph(data, BODIES.male).vertices);
    assert.deepEqual(applyFaceStyleToMorph(data, body, BODIES.male, cache).vertices, body.vertices);
});

test("the body morph cache key ignores only Face Style", () => {
    assert.equal(
        bodyMorphSignature({ age: 30, face_softness: 0.4, face_style: "custom" }),
        bodyMorphSignature({ face_eye_scale: 1, age: 30 }),
    );
    assert.notEqual(bodyMorphSignature({ age: 30 }), bodyMorphSignature({ age: 31 }));
});

test("presets resolve, switch to Custom on edits, and treat old data as Default", () => {
    assert.equal(resolveFaceStylePreset({}), "default");
    assert.equal(resolveFaceStylePreset({ age: 30, gender: 1 }), "default");
    assert.equal(isDefaultFaceStyle({}), true);
    for (const name of Object.keys(FACE_STYLE_PRESETS)) {
        const mesh = { age: 25 };
        assert.equal(applyFaceStylePreset(mesh, name), true);
        assert.equal(mesh.face_style, name);
        assert.equal(resolveFaceStylePreset(mesh), name);
        assert.equal(mesh.age, 25);
    }
    const edited = { ...FACE_STYLE_PRESETS.anime_light, face_style: "anime_light", face_eye_scale: 0.9 };
    assert.equal(resolveFaceStylePreset(edited), "custom");
    assert.equal(resolveFaceStylePreset({ ...FACE_STYLE_PRESETS.soft, face_style: "custom" }), "custom");
    assert.equal(resolveFaceStylePreset({ ...FACE_STYLE_PRESETS.soft, face_style: "bogus" }), "soft");
    assert.equal(applyFaceStylePreset({}, "custom"), false);
    // Presets are distinct and increasing in strength.
    const strength = name => FACE_STYLE_KEYS.reduce((sum, key) => sum + FACE_STYLE_PRESETS[name][key], 0);
    assert.ok(strength("default") < strength("soft"));
    assert.ok(strength("soft") < strength("anime_light"));
    assert.ok(strength("anime_light") < strength("anime_strong"));
});

test("Face Style is stored per character and survives scene serialization", () => {
    const first = createPoseStudioCharacter({
        id: "c1",
        index: 0,
        mesh: { age: 25, ...FACE_STYLE_PRESETS.anime_strong, face_style: "anime_strong" },
    });
    const second = createPoseStudioCharacter({ id: "c2", index: 1, mesh: { age: 40 } });
    const saved = JSON.parse(JSON.stringify({
        schema_version: 3,
        active_character_id: "c2",
        characters: [serializePoseStudioCharacter(first), serializePoseStudioCharacter(second)],
    }));
    const restored = normalizePoseStudioCharacters(saved);
    const [c1, c2] = restored.characters;
    assert.equal(resolveFaceStylePreset(c1.mesh), "anime_strong");
    assert.equal(c1.mesh.face_eye_scale, FACE_STYLE_PRESETS.anime_strong.face_eye_scale);
    // An old character without Face Style data stays Default.
    assert.equal(resolveFaceStylePreset(c2.mesh), "default");
    assert.equal(c2.mesh.face_eye_scale, undefined);
    // Editing one character never aliases the other.
    c2.mesh.face_softness = 0.5;
    assert.equal(c1.mesh.face_softness, FACE_STYLE_PRESETS.anime_strong.face_softness);
    assert.deepEqual(
        solveMorph(data, c2.mesh).bonePositions,
        solveBodyMorph(data, c2.mesh).bonePositions,
    );
});
