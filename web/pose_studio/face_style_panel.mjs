/**
 * Face Style section of the Pose Studio left panel.
 *
 * Values live in the active character's mesh parameters, so persistence,
 * undo snapshots, character switching and Pose Library round trips reuse the
 * existing mesh paths. Slider drags go through the shared live morph worker
 * (`onMeshParamsChanged(..., { liveOnly: true })`) and update every `input`.
 */

import {
    DEFAULT_FACE_STYLE_PARAMS,
    FACE_STYLE_KEYS,
    FACE_STYLE_PRESET_OPTIONS,
    FACE_STYLE_SLIDERS,
    applyFaceStylePreset,
    faceStyleValues,
    isDefaultFaceStyle,
    resolveFaceStylePreset,
} from "./face_style.mjs?v=20261102.1";

// The widget imports Face Style only through this module.
export { DEFAULT_FACE_STYLE_PARAMS, FACE_STYLE_KEYS };

/** Mesh object with missing Face Style fields filled with Default. */
export function withFaceStyleDefaults(mesh = {}) {
    const filled = { ...DEFAULT_FACE_STYLE_PARAMS, ...mesh };
    if (!FACE_STYLE_PRESET_OPTIONS.some(option => option.value === filled.face_style)) {
        filled.face_style = resolveFaceStylePreset(mesh);
    }
    return filled;
}

function requestFaceStyleMorph(studio) {
    studio.onMeshParamsChanged(FACE_STYLE_KEYS[0], { liveOnly: true });
}

export function syncFaceStyleControls(studio) {
    const controls = studio.faceStyleControls;
    if (!controls) return;
    const values = faceStyleValues(studio.meshParams);
    controls.select.value = resolveFaceStylePreset(studio.meshParams);
    for (const key of FACE_STYLE_KEYS) {
        const info = studio.sliders?.[key];
        if (!info) continue;
        info.slider.value = values[key];
        info.label.innerText = values[key].toFixed(2);
    }
}

export function setFaceStylePreset(studio, presetName) {
    if (presetName === "custom") {
        // Choosing Custom keeps the current values; it only changes the label.
        studio.meshParams.face_style = "custom";
        syncFaceStyleControls(studio);
        studio.syncToNode(false, { skipCapture: true });
        return false;
    }
    studio._finishPoseGesture?.();
    endFaceStyleCompare(studio);
    // One undo step per preset change, like a completed slider gesture.
    if (!studio.isAnimationMode?.()) studio.viewer?.recordState?.();
    if (!applyFaceStylePreset(studio.meshParams, presetName)) return false;
    syncFaceStyleControls(studio);
    requestFaceStyleMorph(studio);
    return true;
}

/**
 * Hold-to-compare: shows this character's unstyled face while the button is
 * held. Only a transient live solve is requested; mesh parameters, history
 * and captures never see it, and capture paths end it first.
 */
export function beginFaceStyleCompare(studio) {
    if (studio._faceStyleCompare || isDefaultFaceStyle(studio.meshParams)) return false;
    const worker = studio.ensureMorphWorker?.();
    if (!worker || !studio.viewer?.isInitialized?.()) return false;
    const seq = ++studio._morphSeq;
    if (studio._pendingMorphSolve?.seq != null) {
        studio._morphSeqCharacterIds.delete(studio._pendingMorphSolve.seq);
    }
    studio._morphSeqCharacterIds.set(seq, studio.activeCharacterId);
    studio._pendingMorphSolve = {
        type: "solve",
        seq,
        clientId: studio._morphClientId,
        params: { ...studio.meshParams, ...DEFAULT_FACE_STYLE_PARAMS },
    };
    studio._faceStyleCompare = { characterId: studio.activeCharacterId };
    studio.faceStyleControls?.compare?.classList.add("active");
    studio.flushPendingMorphSolve();
    return true;
}

export function endFaceStyleCompare(studio) {
    if (!studio?._faceStyleCompare) return false;
    studio._faceStyleCompare = null;
    studio.faceStyleControls?.compare?.classList.remove("active");
    // A newer solve of the real parameters always wins over the comparison.
    studio.requestLiveMorph?.(null);
    return true;
}

export function createFaceStyleSection(studio) {
    const section = studio.createSection("Face Style", false);

    const presetField = document.createElement("div");
    presetField.className = "vnccs-ps-field";
    const presetLabel = document.createElement("div");
    presetLabel.className = "vnccs-ps-label";
    presetLabel.innerText = "Preset";
    // Styled by the widget's installCustomSelects() observer on its container.
    const select = document.createElement("select");
    select.className = "vnccs-ps-select";
    for (const option of FACE_STYLE_PRESET_OPTIONS) {
        const element = document.createElement("option");
        element.value = option.value;
        element.innerText = option.label;
        select.appendChild(element);
    }
    select.addEventListener("change", () => setFaceStylePreset(studio, select.value));
    presetField.append(presetLabel, select);
    section.content.appendChild(presetField);

    const adjustments = document.createElement("div");
    adjustments.className = "vnccs-ps-label";
    adjustments.innerText = "Adjustments";
    section.content.appendChild(adjustments);
    for (const { key, label } of FACE_STYLE_SLIDERS) {
        const field = studio.createSliderField(label, key, 0, 1, 0.01, 0, studio.meshParams);
        const slider = studio.sliders[key].slider;
        // Runs after the shared slider handler stored the value: any manual
        // edit keeps the values and shows the preset as Custom.
        slider.addEventListener("input", () => {
            studio.meshParams.face_style = "custom";
            select.value = "custom";
        });
        section.content.appendChild(field);
    }

    const actions = document.createElement("div");
    actions.className = "vnccs-ps-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vnccs-ps-btn";
    reset.innerText = "Reset Face";
    reset.title = "Return this character's face to the unchanged MakeHuman shape";
    reset.addEventListener("click", () => setFaceStylePreset(studio, "default"));
    const compare = document.createElement("button");
    compare.type = "button";
    compare.className = "vnccs-ps-btn";
    compare.innerText = "Compare Default";
    compare.title = "Hold to show the unchanged face; release to return";
    compare.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        try {
            compare.setPointerCapture?.(event.pointerId);
        } catch {
            // Synthetic or already released pointers cannot be captured.
        }
        beginFaceStyleCompare(studio);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
        compare.addEventListener(type, () => endFaceStyleCompare(studio));
    }
    actions.append(reset, compare);
    section.content.appendChild(actions);

    studio.faceStyleControls = { select, compare };
    syncFaceStyleControls(studio);
    return section;
}
