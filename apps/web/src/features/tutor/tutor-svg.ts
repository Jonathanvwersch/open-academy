type TutorSvg = { status: 'valid'; label: string } | { status: 'invalid' | 'unsafe' };

const svgNamespace = 'http://www.w3.org/2000/svg';
const forbiddenElement = /^(?:script|foreignObject)$/i;

export function checkTutorSvg(source: string): TutorSvg {
  if (
    /<\s*(script|foreignObject)\b/i.test(source) ||
    /\bon[a-z0-9_-]*\s*=/i.test(source) ||
    /\b(?:xlink:)?href\s*=\s*(['"])(?!#)[\s\S]*?\1/i.test(source)
  ) {
    return { status: 'unsafe' };
  }

  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (
    root?.localName !== 'svg' ||
    root.namespaceURI !== svgNamespace ||
    document.getElementsByTagName('parsererror').length
  ) {
    return { status: 'invalid' };
  }

  for (const element of document.getElementsByTagName('*')) {
    if (forbiddenElement.test(element.localName)) return { status: 'unsafe' };
    for (const attribute of element.attributes) {
      if (
        /^on/i.test(attribute.localName) ||
        (attribute.localName.toLowerCase() === 'href' && !attribute.value.startsWith('#'))
      ) {
        return { status: 'unsafe' };
      }
    }
  }
  return { status: 'valid', label: root.getAttribute('aria-label')?.trim() ?? '' };
}

export function tutorSvgPlaceholder(status: 'invalid' | 'unsafe', isStreaming: boolean): string {
  return status === 'invalid' && isStreaming ? 'Drawing…' : "Diagram couldn't be shown";
}
