// Shared DOM fixture for page scenarios and isolated row renderers.
class ClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }

  write(values) {
    this.element.className = [...new Set(values)].join(' ');
  }

  add(...names) {
    this.write([...this.values(), ...names]);
  }

  remove(...names) {
    const drop = new Set(names);
    this.write(this.values().filter((name) => !drop.has(name)));
  }

  contains(name) {
    return this.values().includes(name);
  }

  toggle(name, force) {
    const has = this.contains(name);
    const on = force === undefined ? !has : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }

  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]();
  }
}

class Style {
  constructor() {
    this.values = {};
  }

  setProperty(name, value) {
    this.values[name] = value;
  }
}

class TextNode {
  constructor(text, ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.nodeType = 3;
    this.text = String(text);
  }

  get textContent() {
    return this.text;
  }

  set textContent(value) {
    this.text = String(value);
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.parentNode = null;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = new Style();
    this.className = '';
    this.classList = new ClassList(this);
    this.listeners = {};
    this.hidden = false;
    this.title = '';
    this.type = '';
    this.value = '';
    this.offsetHeight = 0;
    this.offsetWidth = 0;
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this.ownText || '';
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  get firstElementChild() {
    return this.children.find((child) => child instanceof Element) || null;
  }

  get childElementCount() {
    return this.children.filter((child) => child instanceof Element).length;
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new TextNode(node, this.ownerDocument) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === 'id') {
      this.id = text;
      this.ownerDocument.byId.set(text, this);
    } else if (name === 'class') {
      this.className = text;
    } else if (name.startsWith('data-')) {
      this.dataset[dataName(name)] = text;
    }
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'style') this.style = new Style();
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !Object.hasOwn(this.attributes, name) : Boolean(force);
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }

  addEventListener(type, listener, capture = false) {
    this.listeners[type] ||= [];
    this.listeners[type].push({ listener, capture });
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    event.preventDefault ||= () => {
      event.defaultPrevented = true;
    };
    event.stopPropagation ||= () => {
      event.stopped = true;
    };
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    for (const [nodes, capture] of [[path.slice().reverse(), true], [path, false]]) {
      for (const node of nodes) {
        event.currentTarget = node;
        for (const entry of node.listeners[event.type] || []) if (entry.capture === capture) entry.listener(event);
        if (event.stopped) return !event.defaultPrevented;
      }
    }
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (node instanceof Element && matchesSimple(node, selector)) return node;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return selectAll([this], selector);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  scrollIntoView() {}

  setPointerCapture() {}
}

class Document {
  constructor() {
    this.byId = new Map();
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.documentElement.append(this.body);
  }

  createElement(tagName) {
    return new Element(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

function dataName(name) {
  return name
    .slice(5)
    .split('-')
    .map((part, index) => (index ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

function descendants(node) {
  const found = [];
  for (const child of node.children || []) {
    if (!(child instanceof Element)) continue;
    found.push(child, ...descendants(child));
  }
  return found;
}

function selectAll(roots, selector) {
  return selector
    .trim()
    .split(/\s+/)
    .reduce((current, part) => current.flatMap((root) => descendants(root).filter((node) => matchesSimple(node, part))), roots);
}

function matchesSimple(element, selector) {
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.localName !== tag.toLowerCase()) return false;
  const id = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1];
  if (id && element.id !== id) return false;
  for (const [, name] of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!element.classList.contains(name)) return false;
  }
  for (const [, name, quoted, bare] of selector.matchAll(/\[([^=\]]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
    const value = element.getAttribute(name);
    if (value === null) return false;
    const expected = quoted ?? bare;
    if (expected !== undefined && value !== expected) return false;
  }
  return true;
}

function add(parent, tagName, id = null) {
  const element = parent.ownerDocument.createElement(tagName);
  if (id) element.setAttribute('id', id);
  parent.append(element);
  return element;
}

function makeDocument() {
  const document = new Document();
  const body = document.body;
  const header = add(body, 'header');
  add(header, 'span', 'summary');
  add(header, 'button', 'refresh');
  add(header, 'button', 'add');
  add(header, 'button', 'settings');
  add(header, 'button', 'more');
  add(body, 'section', 'app-update');
  add(body, 'section', 'update');
  const filterBox = add(body, 'div');
  add(filterBox, 'input', 'filter');
  const repos = add(body, 'main', 'repos');
  for (const name of ['open', 'other', 'uncloned']) {
    const section = add(repos, 'section', `${name}-section`);
    const head = add(section, 'h2', `${name}-head`);
    const toggle = add(head, 'button', `${name}-toggle`);
    toggle.setAttribute('aria-expanded', 'true');
    add(toggle, 'span', `${name}-count`);
    if (name === 'open') add(toggle, 'span', 'open-dot');
    add(section, 'div', `${name}-tree`);
  }
  add(body, 'div', 'gh-bar');
  add(body, 'footer', 'usage');
  add(body, 'div', 'edge');
  return document;
}

function makeLocalStorage(values) {
  const data = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

module.exports = { Document, makeDocument, makeLocalStorage };
