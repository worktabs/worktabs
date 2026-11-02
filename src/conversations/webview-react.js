// Serialized into agent webviews. Keep these bounded discovery helpers self-contained and
// independent of Node, Electron, provider IDs, translated labels, and feature fallbacks.
// The official Codex webview nests its controls under more than 100 provider fibers.
// Leave room for those wrappers while keeping unknown or cyclic trees bounded.
function reactAncestors(element, { maxDepth = 512, maxNodes = 10000 } = {}) {
  const unavailable = (reason) => ({ available: false, reason });
  try {
    if (!element || element.isConnected === false) return unavailable('detached-node');
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    if (!key || !element[key]) return unavailable('missing-fiber');
    let root = element[key]; const ancestors = new Set();
    for (let depth = 0; root?.return; depth++) {
      if (depth >= maxDepth) return unavailable('ancestor-limit');
      if (ancestors.has(root)) return unavailable('malformed-tree');
      ancestors.add(root); root = root.return;
    }
    const current = root?.stateNode?.current;
    if (!current) return unavailable('missing-current-root');
    const stack = [{ fiber: current, props: [], depth: 0 }]; const seen = new Set();
    for (let visited = 0; stack.length; visited++) {
      if (visited >= maxNodes) return unavailable('tree-limit');
      const { fiber, props, depth } = stack.pop();
      if (depth > maxDepth) return unavailable('ancestor-limit');
      if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) return unavailable('malformed-tree');
      seen.add(fiber);
      const chain = fiber.memoizedProps ? [fiber.memoizedProps, ...props] : props;
      if (fiber.stateNode === element) return { available: true, props: chain };
      // Schedule one sibling at a time: a malformed sibling cycle must not trap a for-loop.
      if (fiber.sibling) stack.push({ fiber: fiber.sibling, props, depth });
      if (fiber.child) stack.push({ fiber: fiber.child, props: chain, depth: depth + 1 });
    }
    return unavailable('unmounted-node');
  } catch { return unavailable('unreadable-tree'); }
}

// The props of mounted components that `match`, in the tree `element` is mounted in, each with
// whether the first element it renders is visible. Bounded like reactAncestors.
function reactMountedProps(element, match, { maxNodes = 20000 } = {}) {
  try {
    const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    let root = key && element[key];
    for (let depth = 0; root?.return; depth++) {
      if (depth >= 512) return [];
      root = root.return;
    }
    const stack = [root?.stateNode?.current]; const seen = new Set(); const found = [];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) continue;
      if (seen.size >= maxNodes) return [];
      seen.add(fiber);
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object' && match(fiber.memoizedProps)) {
        let host = fiber;
        for (let steps = 0; host && !host.stateNode?.checkVisibility && steps < 64; steps++) host = host.child;
        const visible = Boolean(host?.stateNode?.checkVisibility?.({ checkVisibilityCSS: true, checkOpacity: true }));
        found.push({ props: fiber.memoizedProps, visible });
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return found;
  } catch { return []; }
}

function reactElementProps(value, { maxDepth = 20, maxNodes = 10000, includeSelected = true } = {}) {
  try {
    const props = []; const stack = [{ value, depth: 0 }]; const seen = new Set();
    while (stack.length) {
      if (seen.size >= maxNodes) return { available: false, reason: 'props-limit' };
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (depth > maxDepth) return { available: false, reason: 'props-depth-limit' };
      if (seen.has(value)) return { available: false, reason: 'malformed-props' };
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length + stack.length + seen.size > maxNodes) return { available: false, reason: 'props-limit' };
        for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth: depth + 1 });
      } else if (value.props) {
        props.push(value.props);
        if (includeSelected && value.props.selectedValue) stack.push({ value: value.props.selectedValue, depth: depth + 1 });
        if (value.props.children) stack.push({ value: value.props.children, depth: depth + 1 });
      }
    }
    return { available: true, props };
  } catch { return { available: false, reason: 'unreadable-props' }; }
}

function webviewReactScript(body) {
  return `(() => { const reactAncestors = ${reactAncestors}; const reactMountedProps = ${reactMountedProps}; const reactElementProps = ${reactElementProps}; ${body} })()`;
}
module.exports = { reactAncestors, reactMountedProps, reactElementProps, webviewReactScript };
