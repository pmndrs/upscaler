import { startDemo, showError } from '../shared/babylon/demo';

// Async bootstrap lets Babylon's lazy shader chunks finish module evaluation.
void startDemo('aliasing').catch(showError);
