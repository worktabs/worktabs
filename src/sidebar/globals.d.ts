// What the side bar page's scripts share. index.html loads them as plain scripts, so each sees
// what the scripts before it declared; tsc treats the ones that also export for the tests
// (`module.exports`) as modules, so their shared names are declared here.

declare const translator: typeof import('../i18n/translate.js').translator;
declare const elapsedText: typeof import('./time.js').elapsedText;
declare const sinceText: typeof import('./time.js').sinceText;
declare const recentChecks: typeof import('./checks.js').recentChecks;
declare const ownChecks: typeof import('./checks.js').ownChecks;
declare const checkLabel: typeof import('./checks.js').checkLabel;
declare const checksLines: typeof import('./checks.js').checksLines;
declare const pressHold: typeof import('./press.js').pressHold;
declare const hoverIntent: typeof import('./hover.js').hoverIntent;
declare const sidebarModel: typeof import('./model.js');
declare const SidebarData: typeof import('./data.js').SidebarData;
declare const createIcons: typeof import('./icons.js').createIcons;
declare const createPullSelectors: typeof import('./pulls.js').createPullSelectors;
declare const createSidebarRows: typeof import('./rows.js').createSidebarRows;
declare const createUnclonedSection: typeof import('./uncloned.js').createUnclonedSection;
declare const createGithubBar: typeof import('./github-bar.js').createGithubBar;
declare const createUpdateCard: typeof import('./update-card.js').createUpdateCard;
declare const createAppUpdateCard: typeof import('./app-update-card.js').createAppUpdateCard;
declare const createUsageFooter: typeof import('./usage-footer.js').createUsageFooter;
declare const attachSidebarResize: typeof import('./resize.js').attachSidebarResize;
declare const createPageTheme: typeof import('./page-theme.js').createPageTheme;

// The UI language and its table (uiLanguage in main.js), from the preload.
interface PageI18n {
  language: string;
  messages: Record<string, string>;
}

// What preload.js exposes as window.host. Replies come from the main process (ipc-table.js).
interface SidebarHost {
  getState(): Promise<any>;
  getRepos(): Promise<any>;
  getWorktrees(repo: string): Promise<any>;
  onUpdate(callback: (state: any) => void): void;
  onRepos(callback: (repos: any) => void): void;
  onReloadWorktrees(callback: (repos: any) => void): void;
  onWorktreeAdded(callback: (repo: any) => void): void;
  onCloned(callback: (repo: any) => void): void;
  addWorktree(repo: string): Promise<any>;
  cloneRepo(url: string): Promise<any>;
  showUnclonedMenu(url: string): Promise<any>;
  showOwnerMenu(key: string): Promise<any>;
  showRepoMenu(repo: string | null, ids: string[]): Promise<any>;
  closeTabs(repo: string | null, ids: string[]): Promise<any>;
  showWorktreeMenu(folder: string, repo: string | null): Promise<any>;
  removeWorktree(folder: string, repo: string | null): Promise<any>;
  open(folder: string): Promise<any>;
  activate(id: string): Promise<any>;
  close(id: string): Promise<any>;
  showAddMenu(): Promise<any>;
  showSettings(): Promise<any>;
  showExtensions(): Promise<any>;
  showMoreMenu(): Promise<any>;
  refreshRepos(): Promise<any>;
  revealNext(state: any): Promise<any>;
  showTabMenu(id: string): Promise<any>;
  revealSession(id: string, sessionId: string): Promise<any>;
  archiveSession(id: string, sessionId: string): Promise<any>;
  github(folder: string): Promise<any>;
  openGithub(folder: string, page: string): Promise<any>;
  openIssue(folder: string, number: number): Promise<any>;
  pullRequests(repo: string, branches: string[], numbers?: Array<[string, number]>, heads?: string[]): Promise<any>;
  openPull(folder: string, number: number): Promise<any>;
  openChecks(folder: string, oid: string): Promise<any>;
  startUpdate(): Promise<any>;
  cancelUpdate(): Promise<any>;
  dismissUpdate(): Promise<any>;
  startAppUpdate(): Promise<any>;
  restartAppUpdate(): Promise<any>;
  cancelAppUpdate(): Promise<any>;
  skipAppUpdate(): Promise<any>;
  dismissAppUpdate(): Promise<any>;
  openAppReleaseNotes(): Promise<any>;
  startResize(): Promise<any>;
  resize(width: number): void;
  endResize(width: number): Promise<any>;
  resetWidth(): Promise<any>;
}

interface Window {
  i18n?: PageI18n;
  host: SidebarHost;
}
