// What the dialog page's scripts share. index.html loads them as plain scripts, so each sees
// what the scripts before it declared; tsc treats the ones that also export for the tests
// (`module.exports`) as modules, so their shared names are declared here.

declare const translator: typeof import('../i18n/translate.js').translator;
declare const dialogKey: typeof import('./keys.js').dialogKey;
declare const formKey: typeof import('./keys.js').formKey;
declare const readAgentChoices: typeof import('./settings-choice.js').readAgentChoices;

// The UI language and its table (uiLanguage in main.js), from the preload.
interface PageI18n {
  language: string;
  messages: Record<string, string>;
}

// What preload.js exposes as window.host. Replies come from the main process (ipc-table.js).
interface DialogHost {
  ready(): Promise<{ dialog: any; theme: any }>;
  answer(id: any, response: number, checkboxChecked?: boolean): Promise<any>;
  copy(): Promise<any>;
  onShow(callback: (dialog: any, theme: any) => void): void;
  onTheme(callback: (theme: any) => void): void;
  worktree: {
    task(repo: string, text: string): Promise<any>;
    plan(repo: string, name: string, task: any): Promise<any>;
    suggest(repo: string, task: any): Promise<any>;
    create(repo: string, name: string, task: any): Promise<any>;
  };
  clone: {
    check(dest: string): Promise<any>;
    browse(dest: string): Promise<any>;
    start(dest: string): Promise<any>;
  };
  settings: {
    save(settings: any): Promise<any>;
  };
  extensions: {
    list(target?: string): Promise<any>;
    browse(kind: string): Promise<any>;
    import(keys: string[], target: string): Promise<any>;
    openVsx(id: string, target: string): Promise<any>;
    rollback(id: string, target: string): Promise<any>;
    openCode(): Promise<any>;
    page(id: string): Promise<any>;
    check(target?: string): Promise<any>;
    update(): Promise<any>;
  };
}

interface Window {
  i18n?: PageI18n;
  host: DialogHost;
}
