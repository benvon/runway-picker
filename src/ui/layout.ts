import { appendChildren, createElement } from './dom';
import type { LookupStage } from '../application/lookup/useCase';

export interface AppElements {
  form: HTMLFormElement;
  icaoInput: HTMLInputElement;
  alternateGroup: HTMLElement;
  alternateIcaoInput: HTMLInputElement;
  alternateHelp: HTMLElement;
  errorNode: HTMLElement;
  submitButton: HTMLButtonElement;
  bestSpotlightNode: HTMLElement;
  resultsNode: HTMLElement;
}

export function setIdleSubmitLabel(submitButton: HTMLButtonElement, stage: LookupStage): void {
  submitButton.textContent = stage === 'alternate-metar' ? 'Lookup Alternate METAR' : 'Lookup Airport and METAR';
}

export function setBusySubmitLabel(submitButton: HTMLButtonElement, stage: LookupStage): void {
  submitButton.textContent = stage === 'alternate-metar' ? 'Fetching alternate METAR...' : 'Fetching airport + METAR...';
}

export function applyPrimaryStageUi(elements: AppElements): void {
  elements.icaoInput.readOnly = false;
  elements.icaoInput.classList.remove('locked-input');
  elements.alternateGroup.hidden = true;
  elements.alternateIcaoInput.required = false;
  elements.alternateIcaoInput.value = '';
  elements.alternateHelp.textContent = '';
}

export function applyAlternateStageUi(elements: AppElements, primaryIcao: string): void {
  elements.icaoInput.readOnly = true;
  elements.icaoInput.classList.add('locked-input');
  elements.alternateGroup.hidden = false;
  elements.alternateIcaoInput.required = true;
  elements.alternateHelp.textContent = `No METAR is currently available for ICAO ${primaryIcao}. Enter an alternate ICAO code for METAR data.`;
}

export function buildAppUi(root: HTMLElement): AppElements {
  root.textContent = '';

  const appShell = createElement('div', { className: 'app-shell' });
  const header = createElement('header', { className: 'panel hero-panel' });
  header.appendChild(createElement('h1', { textContent: 'Runway Picker' }));

  const bestSpotlightNode = createElement('section', {
    className: 'results-stack',
    attributes: {
      id: 'best-runway-spotlight',
      'aria-live': 'polite'
    }
  });

  const inputSection = createElement('section', {
    className: 'panel',
    attributes: { 'aria-labelledby': 'input-title' }
  });
  const inputTitle = createElement('h2', {
    textContent: 'Inputs',
    attributes: { id: 'input-title' }
  });

  const form = createElement('form', {
    attributes: {
      id: 'calculator-form',
      novalidate: ''
    }
  });

  const primaryIcaoLabel = createElement('label', { textContent: 'Primary ICAO code' });
  primaryIcaoLabel.htmlFor = 'icao';

  const icaoInput = createElement('input', {
    className: 'icao-input',
    attributes: {
      id: 'icao',
      name: 'icao',
      type: 'text',
      placeholder: 'Example: KJFK',
      autocomplete: 'off'
    }
  });
  icaoInput.maxLength = 4;
  icaoInput.required = true;

  const alternateGroup = createElement('div', {
    className: 'alternate-group',
    attributes: { id: 'alternate-group' }
  });
  alternateGroup.hidden = true;

  const alternateLabel = createElement('label', { textContent: 'Alternate METAR ICAO code' });
  alternateLabel.htmlFor = 'alternate-icao';

  const alternateIcaoInput = createElement('input', {
    className: 'icao-input',
    attributes: {
      id: 'alternate-icao',
      name: 'alternateIcao',
      type: 'text',
      placeholder: 'Example: KLGA',
      autocomplete: 'off'
    }
  });
  alternateIcaoInput.maxLength = 4;

  const alternateHelp = createElement('p', {
    className: 'field-help',
    attributes: { id: 'alternate-help' }
  });
  appendChildren(alternateGroup, [alternateLabel, alternateIcaoInput, alternateHelp]);

  const submitButton = createElement('button', { textContent: 'Lookup Airport and METAR' });
  submitButton.type = 'submit';

  const errorNode = createElement('p', {
    className: 'error-message',
    attributes: {
      id: 'form-error',
      role: 'alert',
      'aria-live': 'polite'
    }
  });
  appendChildren(form, [primaryIcaoLabel, icaoInput, alternateGroup, submitButton, errorNode]);
  appendChildren(inputSection, [inputTitle, form]);

  const resultsNode = createElement('section', {
    className: 'results-stack',
    attributes: {
      id: 'results',
      'aria-live': 'polite'
    }
  });

  appendChildren(appShell, [header, bestSpotlightNode, inputSection, resultsNode]);
  root.appendChild(appShell);

  return {
    form,
    icaoInput,
    alternateGroup,
    alternateIcaoInput,
    alternateHelp,
    errorNode,
    submitButton,
    bestSpotlightNode,
    resultsNode
  };
}
