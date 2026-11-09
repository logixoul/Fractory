// Monaco is loaded lazily (only the duel diff view needs it). Only the editor worker is used:
// the diff computation runs there; language services are not loaded, tokenization comes from
// the basic-languages contributions (no workers, no network).
type Monaco = typeof import("monaco-editor/editor/editor.api");

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    const [{ default: EditorWorker }, monaco] = await Promise.all([
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/editor/editor.api"),
      import("monaco-editor/basic-languages/monaco.contribution"),
    ]);
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
    return monaco;
  })();
  return loading;
}

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", cs: "csharp",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", css: "css", scss: "scss", html: "html", svelte: "html",
  vue: "html", yml: "yaml", yaml: "yaml", sh: "shell", ps1: "powershell", sql: "sql", rb: "ruby", php: "php",
  swift: "swift", xml: "xml", toml: "ini", ini: "ini",
};

export function languageFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? "plaintext";
}
