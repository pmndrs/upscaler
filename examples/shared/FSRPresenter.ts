// FSRPresenter has graduated into the library as the public `FSR3Pass`
// drop-in. This shim keeps the examples' imports working; new code should
// import `FSR3Pass` from 'three-fsr3' directly.
export { FSR3Pass as FSRPresenter, type FSR3PassConfig as PresenterConfig } from 'three-fsr3';
