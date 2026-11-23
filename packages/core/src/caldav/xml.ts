export interface XmlElement {
  name: string;
  localName: string;
  namespaceUri: string;
  attributes: { [key: string]: string };
  children: XmlElement[];
  text: string;
}

interface NamespaceScope {
  defaultNs: string;
  prefixes: { [prefix: string]: string };
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.charAt(0) === '#') {
          const code =
            entity.charAt(1) === 'x' || entity.charAt(1) === 'X'
              ? parseInt(entity.slice(2), 16)
              : parseInt(entity.slice(1), 10);
          return isNaN(code) ? _match : String.fromCharCode(code);
        }
        return _match;
    }
  });
}

function parseAttributes(attrText: string): { [key: string]: string } {
  const attrs: { [key: string]: string } = {};
  const regex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrText)) !== null) {
    const key = match[1];
    const rawVal = match[2] !== undefined ? match[2] : match[3] || '';
    attrs[key] = decodeXmlEntities(rawVal);
  }
  return attrs;
}

function extendScope(parent: NamespaceScope, attrs: { [key: string]: string }): NamespaceScope {
  const prefixes: { [prefix: string]: string } = {};
  const parentKeys = Object.keys(parent.prefixes);
  for (let i = 0; i < parentKeys.length; i++) {
    prefixes[parentKeys[i]] = parent.prefixes[parentKeys[i]];
  }
  let defaultNs = parent.defaultNs;

  const attrKeys = Object.keys(attrs);
  for (let i = 0; i < attrKeys.length; i++) {
    const key = attrKeys[i];
    if (key === 'xmlns') {
      defaultNs = attrs[key];
    } else if (key.indexOf('xmlns:') === 0) {
      prefixes[key.slice(6)] = attrs[key];
    }
  }
  return { defaultNs, prefixes };
}

function resolveTagName(
  rawName: string,
  scope: NamespaceScope,
): { localName: string; namespaceUri: string } {
  const colonIdx = rawName.indexOf(':');
  if (colonIdx === -1) {
    return { localName: rawName, namespaceUri: scope.defaultNs };
  }
  const prefix = rawName.slice(0, colonIdx);
  const localName = rawName.slice(colonIdx + 1);
  return { localName, namespaceUri: scope.prefixes[prefix] || '' };
}

/**
 * Lightweight, dependency-free, namespace-aware XML parser for CalDAV/WebDAV
 * responses. Runs identically in Browser, Fitbit Companion, and Node.
 */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = {
    name: '#document',
    localName: '#document',
    namespaceUri: '',
    attributes: {},
    children: [],
    text: '',
  };

  const stack: { element: XmlElement; scope: NamespaceScope }[] = [
    { element: root, scope: { defaultNs: '', prefixes: {} } },
  ];

  let pos = 0;
  const len = xml.length;

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      const tail = xml.slice(pos);
      if (tail) {
        stack[stack.length - 1].element.text += decodeXmlEntities(tail);
      }
      break;
    }

    if (lt > pos) {
      const textChunk = xml.slice(pos, lt);
      stack[stack.length - 1].element.text += decodeXmlEntities(textChunk);
    }

    // Comment <!-- ... -->
    if (xml.slice(lt, lt + 4) === '<!--') {
      const end = xml.indexOf('-->', lt + 4);
      pos = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (xml.slice(lt, lt + 9) === '<![CDATA[') {
      const end = xml.indexOf(']]>', lt + 9);
      const content = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      stack[stack.length - 1].element.text += content;
      pos = end === -1 ? len : end + 3;
      continue;
    }

    // Processing instruction <? ... ?> or DOCTYPE <! ... >
    if (xml.charAt(lt + 1) === '?' || xml.charAt(lt + 1) === '!') {
      const end = xml.indexOf('>', lt + 2);
      pos = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) break;

    const tagContent = xml.slice(lt + 1, gt).trim();
    pos = gt + 1;

    if (!tagContent) continue;

    // Closing tag </...>
    if (tagContent.charAt(0) === '/') {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const selfClosing = tagContent.charAt(tagContent.length - 1) === '/';
    const body = selfClosing ? tagContent.slice(0, -1).trim() : tagContent;
    const spaceMatch = /\s/.exec(body);
    const rawName = spaceMatch ? body.slice(0, spaceMatch.index) : body;
    const attrPart = spaceMatch ? body.slice(spaceMatch.index + 1) : '';

    const attrs = parseAttributes(attrPart);
    const parentFrame = stack[stack.length - 1];
    const scope = extendScope(parentFrame.scope, attrs);
    const { localName, namespaceUri } = resolveTagName(rawName, scope);

    const element: XmlElement = {
      name: rawName,
      localName,
      namespaceUri,
      attributes: attrs,
      children: [],
      text: '',
    };

    parentFrame.element.children.push(element);
    if (!selfClosing) {
      stack.push({ element, scope });
    }
  }

  return root.children.length === 1 ? root.children[0] : root;
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

export function findElementsByNS(
  node: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement[] {
  const results: XmlElement[] = [];
  const visit = (el: XmlElement): void => {
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child.localName === localName && child.namespaceUri === namespaceUri) {
        results.push(child);
      }
      visit(child);
    }
  };
  visit(node);
  return results;
}

export function findFirstByNS(
  node: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement | undefined {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.localName === localName && child.namespaceUri === namespaceUri) {
      return child;
    }
    const nested = findFirstByNS(child, namespaceUri, localName);
    if (nested) return nested;
  }
  return undefined;
}

export function getTextByNS(
  node: XmlElement,
  namespaceUri: string,
  localName: string,
): string | undefined {
  const found = findFirstByNS(node, namespaceUri, localName);
  if (!found) return undefined;
  const trimmed = found.text.trim();
  return trimmed ? trimmed : undefined;
}
