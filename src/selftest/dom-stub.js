/**
 * Minimal DOM stub — just enough of the API surface that
 * src/extractors/policy-compliance.js touches, so the extractor can be executed
 * and asserted in plain Node with no dependencies.
 *
 * Implemented: element tree, textContent/innerText, children/parentElement,
 * getAttribute/hasAttribute, querySelectorAll('*'), getClientRects, tagName,
 * document.createTreeWalker(SHOW_TEXT), window.getComputedStyle, location.href.
 * Nothing else — this is a test fixture, not a browser.
 */

export class TextNode {
  constructor(value) {
    this.nodeValue = value;
    this.parentElement = null;
  }
  get textContent() {
    return this.nodeValue;
  }
}

export class Element {
  constructor(tagName, attrs = {}, style = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.style = { fontSize: '14px', fontWeight: '400', display: 'block', visibility: 'visible', opacity: '1', ...style };
    this.childNodes = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.clientHeight = 750;
    this.scrollHeight = 750;
  }

  append(...nodes) {
    for (const n of nodes) {
      n.parentElement = this;
      this.childNodes.push(n);
    }
    return this;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join(' ');
  }

  get innerText() {
    return this.textContent;
  }

  get value() { return String(this.attrs.value || ''); }
  set value(value) { this.attrs.value = String(value); }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  getClientRects() {
    return this.style.display === 'none' ? [] : [{ width: 100, height: 20 }];
  }

  /** Keep this list explicit: new extractor APIs require a matching stub. */
  querySelectorAll(sel) {
    if (!['*', 'a', 'button[role=switch]', 'img[alt]', '#listing-table-pagination kat-pagination'].includes(sel)) throw new Error(`dom-stub: unsupported selector ${sel}`);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    if (sel === '#listing-table-pagination kat-pagination') return out.filter(node => {
      if (node.tagName !== 'KAT-PAGINATION') return false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.getAttribute('id') === 'listing-table-pagination') return true;
      }
      return false;
    });
    return sel === '*' ? out : out.filter((node) => sel === 'a' ? node.tagName === 'A'
      : sel === 'img[alt]' ? node.tagName === 'IMG' && node.hasAttribute('alt')
      : node.tagName === 'BUTTON' && node.getAttribute('role') === 'switch');
  }
}

/** Depth-first list of every text node under `root`, in document order. */
function textNodes(root) {
  const out = [];
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (c instanceof TextNode) out.push(c);
      else walk(c);
    }
  };
  walk(root);
  return out;
}

export const NodeFilter = { SHOW_TEXT: 4 };

export function makeEnv(body, { href = 'https://sellercentral.amazon.com/performance/dashboard', title = 'Account Health' } = {}) {
  const document = {
    body,
    title,
    readyState: 'complete',
    createTreeWalker(root, mask) {
      if (mask !== NodeFilter.SHOW_TEXT) throw new Error('dom-stub: only SHOW_TEXT is supported');
      const nodes = textNodes(root);
      let i = 0;
      return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
    },
  };
  const window = {
    getComputedStyle(el) {
      return el.style || { fontSize: '14px', fontWeight: '400', display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  return { document, window, location: { href } };
}

/** Terse builders so fixtures stay readable. */
export function e(tag, attrs, style, ...children) {
  const el = new Element(tag, attrs || {}, style || {});
  el.append(...children.flat().map((c) => (typeof c === 'string' ? new TextNode(c) : c)));
  return el;
}
export function t(s) {
  return new TextNode(s);
}
