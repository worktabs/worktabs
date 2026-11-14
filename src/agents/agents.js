// Agent providers Worktabs knows how to install and open.
const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    short: 'Claude',
    extension: 'Anthropic.claude-code',
    pack: [],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    short: 'Codex',
    extension: 'OpenAI.chatgpt',
    // The rest of its extension pack (its manifest's extensionPack, and Open VSX's bundled
    // extensions), which is of no use without it.
    pack: ['openai.codex-audio'],
  },
};

const DEFAULT_AGENT = 'claude';

function unique(list) {
  return [...new Set(list)];
}

function validAgent(id) {
  return typeof id === 'string' && Object.hasOwn(AGENTS, id) ? id : null;
}

function normalizeAgents(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const agents = unique(list.map(validAgent).filter(Boolean));
  return agents.length ? agents : [DEFAULT_AGENT];
}

function normalizeAgent(value, agents, fallback = DEFAULT_AGENT) {
  const enabled = normalizeAgents(agents);
  const agent = validAgent(value);
  if (agent && enabled.includes(agent)) return agent;
  const next = validAgent(fallback);
  return next && enabled.includes(next) ? next : enabled[0];
}

function normalizeBranchAgent(value, agents, defaultAgent) {
  if (value === 'default') return 'default';
  return normalizeAgent(value, agents, defaultAgent);
}

function effectiveBranchAgent(config) {
  return config.branchAgent === 'default' ? config.defaultAgent : normalizeAgent(config.branchAgent, config.agents, config.defaultAgent);
}

function agentExtensions(agents) {
  return normalizeAgents(agents).map((id) => AGENTS[id].extension);
}

function isAgentExtension(id) {
  const value = String(id || '').toLowerCase();
  return Object.values(AGENTS).some((agent) => agent.extension.toLowerCase() === value);
}

// The extensions (lowercase IDs) of the agents that `agents` leaves out, with the rest of their
// extension packs.
function leftOutExtensions(agents) {
  const enabled = normalizeAgents(agents);
  return Object.values(AGENTS).filter((agent) => !enabled.includes(agent.id))
    .flatMap((agent) => [agent.extension, ...agent.pack].map((id) => id.toLowerCase()));
}

// The agent whose extension and the rest of its pack hold every one of `ids`, or null.
function agentFor(ids) {
  const lowered = (ids || []).map((id) => String(id).toLowerCase());
  if (!lowered.length) return null;
  const agent = Object.values(AGENTS).find((each) => {
    const own = [each.extension, ...each.pack].map((id) => id.toLowerCase());
    return lowered.every((id) => own.includes(id));
  });
  return agent ? agent.id : null;
}

function extensionAgents(ids) {
  const lowered = new Set((ids || []).map((id) => String(id).toLowerCase()));
  return Object.values(AGENTS).filter((agent) => lowered.has(agent.extension.toLowerCase())).map((agent) => agent.id);
}

/**
 * @param {{ agents?: string[], wrapper?: string, permissionMode?: string, locale?: string }} [options]
 */
function managedAgentSettings({ agents, wrapper, permissionMode, locale } = {}) {
  const enabled = normalizeAgents(agents);
  const settings = {};
  if (enabled.includes('claude')) {
    // claude-wrap adds the app's hooks (--settings) to the sessions it manages only.
    settings['claudeCode.claudeProcessWrapper'] = wrapper;
    // undefined drops the key, so clearing permissionMode also clears an earlier value.
    settings['claudeCode.initialPermissionMode'] = permissionMode || undefined;
  }
  if (enabled.includes('codex')) {
    // Worktabs opens and sizes the panel itself, and decides Windows vs WSL by the tab's folder.
    settings['chatgpt.openOnStartup'] = false;
    settings['chatgpt.runCodexInWindowsSubsystemForLinux'] = false;
    settings['chatgpt.localeOverride'] = locale && locale !== 'en' ? locale : undefined;
  }
  return settings;
}

/**
 * @param {{ agents?: string[], defaultAgent?: string, branchAgent?: string, extensionsDir?: string,
 *   resolve?: typeof import('./agent-cli').resolveAgentCli }} [options]
 * @returns {Promise<string[]>}
 */
async function codexSetupWarnings({ agents, defaultAgent, branchAgent, extensionsDir, resolve } = {}) {
  const enabled = normalizeAgents(agents);
  if (!enabled.includes('codex')) return [];
  const defaultProvider = normalizeAgent(defaultAgent, enabled);
  const branchProvider = normalizeBranchAgent(branchAgent, enabled, defaultProvider);
  if ((branchProvider === 'default' ? defaultProvider : branchProvider) !== 'codex') return [];
  // Authentication is checked by the suggestion itself, in the repository's environment.
  const { resolveAgentCli, cliFailureMessage } = require('./agent-cli');
  try {
    await (resolve || resolveAgentCli)('', 'codex', { extensionsDir });
    return [];
  } catch (error) {
    return [cliFailureMessage('codex', '', error)];
  }
}

module.exports = {
  AGENTS,
  DEFAULT_AGENT,
  agentExtensions,
  agentFor,
  codexSetupWarnings,
  effectiveBranchAgent,
  extensionAgents,
  isAgentExtension,
  leftOutExtensions,
  managedAgentSettings,
  normalizeAgent,
  normalizeAgents,
  normalizeBranchAgent,
};
