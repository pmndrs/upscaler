/** An imperative dispatch was attempted before its required pipelines were ready. */
export class UpscalerNotReadyError extends Error {
    /** Stable diagnostic code for consumers that cannot use instanceof across bundles. */
    readonly code = 'UPSCALER_NOT_READY';

    /**
     * @param surface - The imperative API whose initialization is required
     * @param reason - Preparation is incomplete or the device was lost
     */
    constructor(
        readonly surface: 'Upscaler' | 'MomentsPass' = 'Upscaler',
        readonly reason: 'preparing' | 'device-lost' = 'preparing',
    ) {
        const action = surface === 'MomentsPass'
            ? 'await MomentsPass.init() after configure() before dispatch().'
            : 'await init() (or prepare()) after configure() before dispatch.';
        super(reason === 'device-lost'
            ? '@pmndrs/upscaler: GPU device lost; recreate the renderer and ' + surface + ' before dispatch.'
            : '@pmndrs/upscaler: ' + action +
                ' Initialization is asynchronous; migrate the old immediate-dispatch pattern.');
        this.name = 'UpscalerNotReadyError';
    }
}

const warned = new WeakSet<object>();

/**
 * Reports actual readiness misuse once per instance while keeping dispatch fail-fast.
 * @param instance - The owning pass/upscaler
 * @param surface - API used in the migration message
 * @param reason - Preparation is incomplete or the device was lost
 * @returns The error the caller must throw before encoding GPU commands
 * @internal
 */
export function notReadyError(
    instance: object,
    surface: 'Upscaler' | 'MomentsPass',
    reason: 'preparing' | 'device-lost' = 'preparing',
): UpscalerNotReadyError {
    const error = new UpscalerNotReadyError(surface, reason);
    if (!warned.has(instance)) {
        warned.add(instance);
        console.warn(error.message);
    }
    return error;
}
