// Shared mounted/alternate fixture for all private React integration probes.
function mountReact(element, props, { alternateProps = null } = {}) {
  const rootState = {};
  const build = (values) => {
    const root = { stateNode: rootState }; const contexts = []; let parent = root;
    for (const memoizedProps of values.slice().reverse()) {
      const context = { memoizedProps, return: parent }; contexts.unshift(context);
      parent.child = context; parent = context;
    }
    const leaf = { stateNode: element, return: parent }; parent.child = leaf;
    return { root, contexts, leaf };
  };
  const current = build(props); rootState.current = current.root;
  const alternate = alternateProps ? build(alternateProps) : null;
  // React pairs each fiber with its alternate. Pair them by depth from the root, as far as both
  // trees go; a deeper difference leaves no path from the alternate leaf into the current tree.
  const pair = (a, b) => { a.alternate = b; b.alternate = a; };
  if (alternate) {
    pair(current.root, alternate.root); pair(current.leaf, alternate.leaf);
    const [cur, alt] = [current.contexts.slice().reverse(), alternate.contexts.slice().reverse()];
    for (let i = 0; i < Math.min(cur.length, alt.length); i++) pair(cur[i], alt[i]);
  }
  element.__reactFiber$fixture = alternate ? alternate.leaf : current.leaf;
  return { element, root: current.root, context: current.contexts[0], contexts: current.contexts, alternate };
}
module.exports = { mountReact };
