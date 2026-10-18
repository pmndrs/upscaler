import type { OrthographicCamera, PerspectiveCamera } from 'three';

/** A camera whose projection honours `setViewOffset` (perspective or orthographic). */
export type ViewOffsetCamera = PerspectiveCamera | OrthographicCamera;

/** The fields of three's `camera.view` (see `PerspectiveCamera.setViewOffset`). */
export interface CameraView {
    enabled: boolean;
    fullWidth: number;
    fullHeight: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
}

/**
 * The camera's view state from before a jitter was applied — hand it back to
 * {@link restoreViewOffset}. `view` is a copy (or `null` when the camera never
 * had a view offset).
 */
export interface ViewOffsetSnapshot {
    camera: ViewOffsetCamera;
    view: CameraView | null;
}

/**
 * Offsets the camera's projection by a sub-pixel jitter **on top of** whatever
 * view offset the app already set (tiled / multi-screen rendering), and returns
 * what's needed to undo it exactly.
 *
 * The jitter is in render-target pixels. three maps a view offset linearly onto
 * the frustum (`left += offsetX · frustumWidth / fullWidth`, the same for both
 * camera types), and an enabled app view renders its `width × height` slice of
 * the `fullWidth × fullHeight` frustum into the render target — so one render
 * pixel spans `width / renderWidth` view units. Without an app view the render
 * target *is* the full view and this reduces to TRAA's
 * `setViewOffset(renderWidth, renderHeight, jx, jy, renderWidth, renderHeight)`.
 *
 * Writes the fields directly instead of calling `setViewOffset`, which would
 * also overwrite a perspective camera's `aspect` with the view's — the jitter
 * must not change the frustum shape, or the jittered projection would drift
 * from the unjittered one the velocity node uses.
 *
 * @param camera - The camera to jitter (its projection matrix is updated)
 * @param jitterX - Horizontal jitter in render pixels
 * @param jitterY - Vertical jitter in render pixels
 * @param renderWidth - Render-target width in pixels
 * @param renderHeight - Render-target height in pixels
 * @returns The pre-jitter state for {@link restoreViewOffset}
 */
export function applyJitterViewOffset(
    camera: ViewOffsetCamera,
    jitterX: number,
    jitterY: number,
    renderWidth: number,
    renderHeight: number,
): ViewOffsetSnapshot {
    const app = camera.view as CameraView | null;
    const snapshot: ViewOffsetSnapshot = { camera, view: app ? { ...app } : null };

    if (app?.enabled) {
        app.offsetX += (jitterX * app.width) / renderWidth;
        app.offsetY += (jitterY * app.height) / renderHeight;
    } else {
        const view: CameraView = app ?? {
            enabled: true,
            fullWidth: 1,
            fullHeight: 1,
            offsetX: 0,
            offsetY: 0,
            width: 1,
            height: 1,
        };
        view.enabled = true;
        view.fullWidth = renderWidth;
        view.fullHeight = renderHeight;
        view.offsetX = jitterX;
        view.offsetY = jitterY;
        view.width = renderWidth;
        view.height = renderHeight;
        camera.view = view;
    }
    camera.updateProjectionMatrix();
    return snapshot;
}

/**
 * Undoes {@link applyJitterViewOffset}: puts the camera's view back exactly as
 * it was (a disabled or absent view stays disabled/absent; an app view gets its
 * original values back) and refreshes the projection matrix. Restores in place
 * so an app holding a reference to `camera.view` keeps a live object.
 *
 * @param snapshot - The value {@link applyJitterViewOffset} returned
 */
export function restoreViewOffset(snapshot: ViewOffsetSnapshot): void {
    const { camera, view } = snapshot;
    if (view === null) {
        camera.view = null;
    } else if (camera.view) {
        Object.assign(camera.view, view);
    } else {
        camera.view = { ...view };
    }
    camera.updateProjectionMatrix();
}
