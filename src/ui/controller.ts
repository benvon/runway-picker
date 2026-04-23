import {
  createPrimaryState,
  normalizeIcaoInput,
  runAlternateLookup,
  runPrimaryLookup,
  type LookupGateway,
  type LookupResolution,
  type LookupState
} from '../application/lookup/useCase';
import { shouldEnableUpdateChecks, shouldPromptForAppUpdate } from '../application/updateMonitor';
import type { BuildMetadata } from '../buildMetadata';
import { fetchLatestBuildMetadata as fetchLatestBuildMetadataDefault } from '../services/versionManifest';
import {
  applyAlternateStageUi,
  applyPrimaryStageUi,
  buildAppUi,
  setBusySubmitLabel,
  setIdleSubmitLabel,
  showAppUpdateNotice
} from './layout';
import { renderErrorTechnicalDetails, renderLookupPanels } from './presenter';

const MIN_FEEDBACK_MS = 250;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
type CleanupFn = () => void;

export interface AppControllerOptions {
  fetchLatestBuildMetadata?: () => Promise<BuildMetadata | null>;
  reloadPage?: () => void;
  updateCheckIntervalMs?: number;
}

interface SuccessfulLookupExecution {
  type: 'success';
  state: LookupState;
  resolution: LookupResolution;
}

interface AlternatePromptLookupExecution {
  type: 'prompt-alternate';
  state: LookupState;
  message: string;
}

type LookupExecutionResult = SuccessfulLookupExecution | AlternatePromptLookupExecution;

function blurActiveElement(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

function applyStateUi(elements: ReturnType<typeof buildAppUi>, state: LookupState): void {
  if (state.stage === 'alternate-metar') {
    applyAlternateStageUi(elements, state.primaryIcao);
  } else {
    applyPrimaryStageUi(elements);
  }
  setIdleSubmitLabel(elements.submitButton, state.stage);
}

function clearResults(elements: ReturnType<typeof buildAppUi>): void {
  elements.bestSpotlightNode.replaceChildren();
  elements.resultsNode.replaceChildren();
}

function renderResolution(elements: ReturnType<typeof buildAppUi>, resolution: LookupResolution): void {
  const panels = renderLookupPanels(resolution);
  elements.bestSpotlightNode.replaceChildren(panels.bestRunway);
  elements.resultsNode.replaceChildren(panels.details);
}

function renderError(elements: ReturnType<typeof buildAppUi>, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  elements.errorNode.textContent = message;
  elements.bestSpotlightNode.replaceChildren();
  const technicalDetails = renderErrorTechnicalDetails(error);
  elements.resultsNode.replaceChildren(...(technicalDetails ? [technicalDetails] : []));
}

async function runLookupExecution(
  state: LookupState,
  elements: ReturnType<typeof buildAppUi>,
  gateway: LookupGateway
): Promise<LookupExecutionResult> {
  const primaryIcao = normalizeIcaoInput(elements.icaoInput.value);
  elements.icaoInput.value = primaryIcao;

  if (state.stage === 'alternate-metar') {
    const alternateIcao = normalizeIcaoInput(elements.alternateIcaoInput.value);
    elements.alternateIcaoInput.value = alternateIcao;
    const result = await runAlternateLookup(state, alternateIcao, gateway);
    return {
      type: 'success',
      state: result.state,
      resolution: result.resolution
    };
  }

  const result = await runPrimaryLookup(primaryIcao, gateway);
  if (result.type === 'prompt-alternate') {
    return result;
  }

  return {
    type: 'success',
    state: result.state,
    resolution: result.resolution
  };
}

function applyLookupExecution(elements: ReturnType<typeof buildAppUi>, result: LookupExecutionResult): LookupState {
  if (result.type === 'prompt-alternate') {
    clearResults(elements);
    elements.errorNode.textContent = result.message;
    applyStateUi(elements, result.state);
    return result.state;
  }

  elements.errorNode.textContent = '';
  applyStateUi(elements, result.state);
  renderResolution(elements, result.resolution);
  return result.state;
}

function registerUpdateMonitor(
  elements: ReturnType<typeof buildAppUi>,
  buildMetadata: BuildMetadata,
  options: AppControllerOptions
): CleanupFn {
  if (!shouldEnableUpdateChecks(buildMetadata)) {
    return () => {};
  }

  const fetchLatestBuildMetadata = options.fetchLatestBuildMetadata ?? fetchLatestBuildMetadataDefault;
  const reloadPage = options.reloadPage ?? (() => window.location.reload());
  const updateCheckIntervalMs = options.updateCheckIntervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  let updatePromptShown = false;
  let updateCheckInFlight = false;

  const handleReloadClick = (): void => {
    reloadPage();
  };
  elements.reloadButton.addEventListener('click', handleReloadClick);

  async function checkForAppUpdate(): Promise<void> {
    if (updatePromptShown || updateCheckInFlight) {
      return;
    }

    // Focus and visibility events can land close together; keep only one request active.
    updateCheckInFlight = true;

    try {
      const latestBuild = await fetchLatestBuildMetadata();
      if (!latestBuild || !shouldPromptForAppUpdate(buildMetadata, latestBuild)) {
        return;
      }

      updatePromptShown = true;
      showAppUpdateNotice(elements, latestBuild);
    } catch {
      // Treat network or injected implementation failures as "no update available".
      return;
    } finally {
      updateCheckInFlight = false;
    }
  }

  const handleWindowFocus = (): void => {
    void checkForAppUpdate();
  };
  window.addEventListener('focus', handleWindowFocus);

  const handleVisibilityChange = (): void => {
    if (!document.hidden) {
      void checkForAppUpdate();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  const intervalHandle = window.setInterval(() => {
    if (!document.hidden) {
      void checkForAppUpdate();
    }
  }, updateCheckIntervalMs);
  const maybeNodeTimer = intervalHandle as unknown as { unref?: () => void };
  if (typeof maybeNodeTimer.unref === 'function') {
    maybeNodeTimer.unref();
  }

  return () => {
    elements.reloadButton.removeEventListener('click', handleReloadClick);
    window.removeEventListener('focus', handleWindowFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.clearInterval(intervalHandle);
  };
}

export function mountAppController(
  root: HTMLElement,
  gateway: LookupGateway,
  buildMetadata: BuildMetadata,
  options: AppControllerOptions = {}
): CleanupFn {
  const elements = buildAppUi(root, buildMetadata);
  let lookupState = createPrimaryState();
  applyStateUi(elements, lookupState);
  const cleanupUpdateMonitor = registerUpdateMonitor(elements, buildMetadata, options);

  const handleSubmit = async (event: Event): Promise<void> => {
    event.preventDefault();
    blurActiveElement();

    elements.errorNode.textContent = '';
    elements.submitButton.disabled = true;
    setBusySubmitLabel(elements.submitButton, lookupState.stage);
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = await runLookupExecution(lookupState, elements, gateway);
      lookupState = applyLookupExecution(elements, result);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Primary airport context is missing')) {
        lookupState = createPrimaryState();
        applyStateUi(elements, lookupState);
      }
      renderError(elements, error);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, MIN_FEEDBACK_MS - elapsedMs);
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      }

      elements.submitButton.disabled = false;
      setIdleSubmitLabel(elements.submitButton, lookupState.stage);
    }
  };

  elements.form.addEventListener('submit', handleSubmit);

  return () => {
    cleanupUpdateMonitor();
    elements.form.removeEventListener('submit', handleSubmit);
  };
}
