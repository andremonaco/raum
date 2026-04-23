import { createSignal } from "solid-js";

// Dev-only override that force-mounts the OnboardingWizard regardless of the
// stored `config.onboarded` flag. Set from a debug button in the top row;
// cleared by the wizard's `onDone` callback when the user finishes or skips.
const [previewOnboarding, setPreviewOnboarding] = createSignal(false);

export { previewOnboarding, setPreviewOnboarding };
