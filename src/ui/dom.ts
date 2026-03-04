export function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: {
    className?: string;
    textContent?: string;
    attributes?: Record<string, string>;
  } = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (typeof options.textContent === 'string') {
    element.textContent = options.textContent;
  }

  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      element.setAttribute(name, value);
    }
  }

  return element;
}

export function appendChildren(parent: Node, children: Array<Node | null | undefined>): void {
  for (const child of children) {
    if (child) {
      parent.appendChild(child);
    }
  }
}

export function clearNode(node: Node): void {
  node.textContent = '';
}

export function strongLabel(label: string): HTMLElement {
  const strong = createElement('strong', { textContent: label });
  return strong;
}

export function createTextParagraph(
  label: string,
  value: string,
  className?: string
): HTMLParagraphElement {
  const paragraph = createElement('p', className ? { className } : {});
  paragraph.append(strongLabel(label), document.createTextNode(` ${value}`));
  return paragraph;
}
