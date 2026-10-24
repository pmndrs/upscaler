// The published package. `.` stays the three.js surface so existing imports keep
// working; engine code lives in the private workspace packages under packages/
// and is bundled in at build time.
export * from '@pmndrs/upscaler-three';
