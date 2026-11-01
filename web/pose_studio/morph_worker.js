import {
    buildModelIndices,
    buildStaticModelData,
    loadMorphPack,
    solveBodyMorph,
} from "./morph_runtime.mjs";
import { applyFaceStyleToMorph, bodyMorphSignature } from "./face_style.mjs";

let morphDataPromise = null;
let morphData = null;
const clientGenitalState = new Map();
// Recent unstyled body solves (one per character in a typical scene). A Face
// Style slider drag reuses the body morph and only re-applies the face stage.
const BODY_MORPH_CACHE_LIMIT = 4;
const bodyMorphCache = new Map();

function solveMorphCached(data, params) {
    const key = bodyMorphSignature(params);
    let entry = bodyMorphCache.get(key);
    if (entry) {
        bodyMorphCache.delete(key);
    } else {
        entry = { body: solveBodyMorph(data, params) };
        while (bodyMorphCache.size >= BODY_MORPH_CACHE_LIMIT) {
            bodyMorphCache.delete(bodyMorphCache.keys().next().value);
        }
    }
    bodyMorphCache.set(key, entry);
    return applyFaceStyleToMorph(data, entry.body, params, entry);
}

async function ensureMorphData() {
    if (morphData) return morphData;
    if (!morphDataPromise) {
        morphDataPromise = loadMorphPack().then((loaded) => {
            morphData = loaded;
            return loaded;
        });
    }
    return morphDataPromise;
}

self.onmessage = async (event) => {
    const { type, seq, params, clientId, includeStatic = false } = event.data || {};
    try {
        if (type === "warmup") {
            await ensureMorphData();
            self.postMessage({ type: "ready", clientId });
            return;
        }
        if (type !== "solve") return;

        const data = await ensureMorphData();
        const result = solveMorphCached(data, params || {});
        const previousGenitalState = clientGenitalState.get(clientId);
        const topologyChanged = previousGenitalState !== undefined
            && previousGenitalState !== result.includeGenitals;
        clientGenitalState.set(clientId, result.includeGenitals);

        const staticData = includeStatic
            ? buildStaticModelData(data, result.includeGenitals)
            : null;
        const indices = !includeStatic && topologyChanged
            ? buildModelIndices(data, result.includeGenitals)
            : null;
        const transfers = [result.vertices.buffer, result.bonePositions.buffer];
        if (staticData) {
            transfers.push(
                staticData.uvs.buffer,
                staticData.indices.buffer,
                staticData.skinIndices.buffer,
                staticData.skinWeights.buffer,
            );
        }
        if (indices) transfers.push(indices.buffer);

        self.postMessage({
            type: "result",
            seq,
            clientId,
            vertices: result.vertices,
            bonePositions: result.bonePositions,
            landmarks: result.landmarks,
            landmarkIndices: result.landmarkIndices,
            staticData,
            indices,
        }, transfers);
    } catch (error) {
        self.postMessage({
            type: "error",
            seq,
            clientId,
            message: error?.message || String(error),
        });
    }
};
