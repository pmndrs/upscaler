// UpscalePresenter has graduated into the library as the public `UpscalePass`
// drop-in. This shim keeps the examples' imports working; new code should
// import `UpscalePass` from '@pmndrs/upscaler' directly.
export { UpscalePass as UpscalePresenter, type UpscalePassConfig as PresenterConfig } from '@pmndrs/upscaler';
