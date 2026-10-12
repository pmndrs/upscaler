import { Engine } from '@babylonjs/core/Engines/engine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { FrameGraphTextureManager } from '@babylonjs/core/FrameGraph/frameGraphTextureManager.js';
import type { TextureResource } from '../core/types.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Matrix } from '@babylonjs/core/Maths/math.vector.js';

/** All Babylon 9.29 private access lives here. No independent queue submission. */
interface EngineInternals {
    _device: GPUDevice;
    _renderEncoder: GPUCommandEncoder;
    _endCurrentRenderPass(): void;
}
const views = new WeakMap<GPUTexture, GPUTextureView>();

function internals(engine: AbstractEngine): EngineInternals {
    if (!/^9\.29\./.test(Engine.Version)) throw new Error(`@pmndrs/upscaler: Babylon ${Engine.Version} is unsupported; use 9.29.x.`);
    const candidate = engine as unknown as Partial<EngineInternals>;
    if (!candidate._device || !candidate._renderEncoder || typeof candidate._endCurrentRenderPass !== 'function') throw new Error('@pmndrs/upscaler: an initialized Babylon WebGPUEngine is required.');
    return candidate as EngineInternals;
}

/**
 * Access the initialized Babylon 9.29 WebGPU device through the guarded bridge.
 * @param engine - Host WebGPU engine.
 * @returns The engine-owned device.
 * @throws If the engine version or internals are unsupported.
 */
export function getBabylonDevice(engine: AbstractEngine): GPUDevice { return internals(engine)._device; }
/**
 * Preserve host projection ownership while temporarily applying jitter.
 * @param camera - Camera whose projection will be temporarily frozen.
 * @param projection - Jittered projection to use while rendering inputs.
 * @returns A callback restoring both the original matrix and its frozen state.
 */
export function freezeJitteredProjection(camera: Camera, projection: Matrix): () => void {
    const frozen = (camera as unknown as { _doNotComputeProjectionMatrix: boolean })._doNotComputeProjectionMatrix;
    const original = camera.getProjectionMatrix().clone(); camera.freezeProjectionMatrix(projection);
    return () => { camera.freezeProjectionMatrix(original); if (!frozen) camera.unfreezeProjectionMatrix(); };
}
/**
 * Close the active render pass before borrowing Babylon's current encoder.
 * @param engine - Initialized Babylon 9.29 WebGPU engine.
 * @returns The host-owned encoder, which the caller must not finish or submit.
 * @throws If the engine version or internals are unsupported.
 */
export function getBabylonEncoder(engine: AbstractEngine): GPUCommandEncoder {
    const host = internals(engine); host._endCurrentRenderPass(); return host._renderEncoder;
}
/**
 * Resolve a Frame Graph handle at execution time, after native history rotation.
 * @param manager - Texture manager owning the allocation.
 * @param handle - Concrete or resolved dangling texture handle.
 * @param write - Select history.write; use true for the current dilated-depth guide.
 * @returns The GPU texture and cached single-mip view, without transferring ownership.
 * @throws If the handle has no WebGPU allocation.
 */
export function resolveBabylonTexture(manager: FrameGraphTextureManager, handle: number, write = false): TextureResource {
    const internal = manager.getTextureFromHandle(handle, write);
    const hardware = internal?._hardwareTexture as unknown as { underlyingResource?: GPUTexture } | undefined;
    const texture = hardware?.underlyingResource;
    if (!texture) throw new Error(`@pmndrs/upscaler: Babylon texture handle ${handle} has no WebGPU allocation.`);
    let view = views.get(texture);
    if (!view) {
        view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1, aspect: texture.format.startsWith('depth') ? 'depth-only' : 'all' });
        views.set(texture, view);
    }
    return { texture, view };
}
